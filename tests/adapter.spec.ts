import { describe, expect, it } from 'vitest'
import { createRaccoonAdapter, displaysAsFree, reasoningFields } from '../src/adapter.ts'
import { RaccoonCatalog } from '../src/catalog.ts'
import type { RaccoonCatalogModel } from '../src/catalog.ts'
import type { RaccoonProbeRecord } from '../src/probe-store.ts'
import type { RaccoonShim } from '../src/shim.ts'

/**
 * The two decisions the adapter carries into pi-ai:
 *
 * - reasoning capability becomes a picker control ONLY for a `validating`
 *   probe record, and `off`/`minimal` are never offered — no amount of other
 *   levels accepting proves the model can be silenced;
 * - the display name carries the price (`label · x0.79 · 限时免费`), because
 *   the composer seat renders `model.name` only; a row with nothing stateable
 *   to say about price gets no number at all rather than a stale one.
 */

const model = (id: string, label: string, extra: Partial<RaccoonCatalogModel> = {}): RaccoonCatalogModel => ({
  id,
  label,
  visible: true,
  tags: [],
  abilityLevel: 1,
  billingDiscounts: [],
  ...extra,
})

const probeRecord = (overrides: { validation?: RaccoonProbeRecord['validation'], efforts?: readonly string[] } = {}): RaccoonProbeRecord => ({
  fingerprint: 'fp',
  validation: overrides.validation ?? 'validating',
  efforts: overrides.efforts ?? [],
  probedAtMs: 1,
  pluginVersion: '0.1.0',
  account: 'alice',
})

describe('reasoningFields', () => {
  it('offers no control for a model with no observation at all', () => {
    expect(reasoningFields(undefined)).toStrictEqual({ reasoning: false })
  })

  it('offers no control for a non-validating upstream — its yeses prove nothing', () => {
    expect(reasoningFields(probeRecord({ validation: 'non-validating', efforts: ['low', 'high'] })))
      .toStrictEqual({ reasoning: false })
    expect(reasoningFields(probeRecord({ validation: 'unknown' }))).toStrictEqual({ reasoning: false })
    // A validating record that accepted nothing is honest silence, not a
    // control with every slot greyed out.
    expect(reasoningFields(probeRecord({ efforts: [] }))).toStrictEqual({ reasoning: false })
  })

  it('maps accepted levels to themselves and everything else to null, off and minimal always null', () => {
    const out = reasoningFields(probeRecord({ efforts: ['low', 'high', 'sentinel-ish'] }))
    expect(out.reasoning).toBe(true)
    expect(out.thinkingLevelMap).toStrictEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: null,
    })
    // The full ladder maps 1:1 onto the wire spellings.
    const all = reasoningFields(probeRecord({ efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }))
    expect(all.thinkingLevelMap).toStrictEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    })
  })
})

describe('adapter model descriptors', () => {
  function adapterWith(
    models: readonly RaccoonCatalogModel[],
    observed?: (modelId: string) => RaccoonProbeRecord | undefined,
  ) {
    const catalog = new RaccoonCatalog()
    catalog.set({ models })
    const shim = {
      baseUrl: () => 'http://127.0.0.1:1',
      token: () => 'shim-secret',
      port: () => 1,
      models: () => ({ object: 'list', data: [] }),
      stop: async () => {},
    } as unknown as RaccoonShim
    const created = createRaccoonAdapter({
      providerId: 'raccoon',
      displayName: '商汤小浣熊',
      shim,
      catalog,
      ...(observed === undefined ? {} : { observe: observed }),
    })
    return { ...created, catalog }
  }

  it('composes the picker name as label · rate · promotion badge', async () => {
    const { adapter } = adapterWith([
      model('glm', 'GLM-5.2', {
        billingMultiplier: 1,
        billingDiscounts: [{ name: '限时免费', multiplier: 0.79, active: true }],
      }),
    ])
    const [listed] = await adapter.listModels('raccoon')
    expect(listed?.name).toBe('GLM-5.2 · x0.79 · 限时免费')
    expect(listed?.id).toBe('glm')
  })

  it('appends nothing to the name of a row with no stateable price', async () => {
    const { adapter } = adapterWith([
      // Only an ended promotion: no list price to restore, no badge live.
      model('old', 'Old Promo', { billingDiscounts: [{ name: 'promo', multiplier: 0.5, active: false, endAt: '2020-01-01' }] }),
      // No billing at all (a fallback-roster row).
      model('bare', 'Bare'),
    ])
    const listed = await adapter.listModels('raccoon')
    const byId = new Map(listed.map(info => [info.id, info]))
    expect(byId.get('old')?.name).toBe('Old Promo')
    expect(byId.get('bare')?.name).toBe('Bare')
    expect(byId.get('old')?.name).not.toContain('x0.')
  })

  it('uses the id as the base name when the upstream gave no label', async () => {
    const { adapter } = adapterWith([model('sn-x', '')])
    const [listed] = await adapter.listModels('raccoon')
    expect(listed?.name).toBe('sn-x')
  })

  it('describes vision-tagged models as text+image and everything else text-only', async () => {
    const { adapter } = adapterWith([
      model('v', 'V', { tags: ['vision'] }),
      model('t', 'T'),
      // The two rows where the upstream tag and the measurement disagree. Declaring
      // image for `sn-glm-5-3` would let an image in that the gateway then discards;
      // withholding it from `sn-deepseek-v4-1-flash` would block a model that reads
      // images and has no tag saying so.
      model('sn-deepseek-v4-1-flash', 'DeepSeek-V4.1-Flash', { tags: ['general', 'code'] }),
      model('sn-glm-5-3', 'GLM-5-3', { tags: ['vision', 'code'] }),
    ])
    const listed = await adapter.listModels('raccoon')
    const byId = new Map(listed.map(info => [info.id, info]))
    expect(byId.get('v')?.inputModalities).toEqual(['text', 'image'])
    expect(byId.get('t')?.inputModalities).toEqual(['text'])
    expect(byId.get('sn-deepseek-v4-1-flash')?.inputModalities).toEqual(['text', 'image'])
    expect(byId.get('sn-glm-5-3')?.inputModalities).toEqual(['text'])
  })

  it('folds a validating observation into the resolved model, and a non-validating one into nothing', async () => {
    const { adapter } = adapterWith(
      [model('glm', 'GLM')],
      id => id === 'glm' ? probeRecord({ efforts: ['low', 'max'] }) : undefined,
    )
    const resolved = await adapter.resolveModel('raccoon', 'glm')
    expect(resolved.name).toBe('GLM')
    // dsh-llm surfaces the accepted levels as picker efforts; the exact map
    // itself is pinned in reasoningFields above.
    expect(new Set(resolved.reasoning?.efforts.map(effort => effort.id))).toEqual(new Set(['low', 'max']))

    const { adapter: plain } = adapterWith(
      [model('glm', 'GLM')],
      () => probeRecord({ validation: 'non-validating', efforts: ['low'] }),
    )
    const quiet = await plain.resolveModel('raccoon', 'glm')
    // A non-validating upstream yields no control at all — not a greyed-out
    // one: its acceptance of a sentinel voids every yes it could give.
    expect(quiet.reasoning).toBeUndefined()
  })

  it('rebuilds the answer set live: invalidate is not required for billing to re-derive', async () => {
    const { adapter, catalog } = adapterWith([
      model('glm', 'GLM', {
        billingMultiplier: 1,
        billingDiscounts: [{ name: '夜', multiplier: 0.5, active: true }],
      }),
    ])
    const first = await adapter.listModels('raccoon')
    expect(first[0]?.name).toBe('GLM · x0.50 · 夜')
    catalog.hide()
    const afterHide = await adapter.listModels('raccoon')
    // Hidden group serves nothing; the roster itself was only hidden, not lost.
    expect(afterHide).toEqual([])
    catalog.show()
    expect((await adapter.listModels('raccoon'))[0]?.name).toBe('GLM · x0.50 · 夜')
  })
})

describe('displaysAsFree', () => {
  it('flags exactly the zero-multiplier rows for the x0.00 chip', () => {
    expect(displaysAsFree(model('a', 'A', { billingEffectiveMultiplier: 0 }))).toBe(true)
    expect(displaysAsFree(model('b', 'B', { billingMultiplier: 0 }))).toBe(true)
    expect(displaysAsFree(model('c', 'C', { billingEffectiveMultiplier: 0.79 }))).toBe(false)
    expect(displaysAsFree(model('d', 'D'))).toBe(false)
  })
})
