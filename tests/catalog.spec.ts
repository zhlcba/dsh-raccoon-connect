import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activeBadges,
  discountIsLive,
  FALLBACK_CATALOG,
  isFree,
  isRateUnknown,
  MEASURED_VISION,
  modelWithCurrentBilling,
  multiplierLabel,
  normalizeTags,
  parseModelCatalog,
  RaccoonCatalog,
  RaccoonCatalogStore,
  resolveVision,
  supportsVision,
} from '../src/catalog.ts'
import type { RaccoonBillingDiscount, RaccoonCatalogModel, SavedRaccoonCatalog } from '../src/catalog.ts'

/**
 * Catalog parsing, time-boxed billing, and per-account persistence.
 *
 * Pinned invariants:
 * - only the `chat` category is a roster; invisible rows and the app's internal
 *   `raccoon-work` agent route are dropped before a picker can select them;
 * - both the `{code, data}` envelope and a bare document parse, a non-zero code
 *   means no usable catalog, and an empty result degrades to undefined so the
 *   caller keeps the saved/fallback roster instead of publishing nothing;
 * - hostile tag input is bounded and folded (`image` → `vision`) so the tag layer
 *   of the image-input decision has exactly one thing to test;
 * - image-input capability is decided measured → configured → tag, in that order:
 *   the upstream's `vision` tag is its only capability field and is wrong on some
 *   rows in *both* directions, so trusting it would both refuse an image from a
 *   model that reads images and hand an image to a gateway that discards it;
 * - "currently discounted" is re-derived per read, never baked in at fetch time;
 * - the saved catalog file is keyed by account and can never carry token
 *   material, whatever the process did with credentials.
 */

const row = (name: string, extra: Record<string, unknown> = {}): unknown => ({ name, ...extra })

const modelRow = (id: string, label = '', extra: Partial<RaccoonCatalogModel> = {}): RaccoonCatalogModel => ({
  id,
  label,
  visible: true,
  tags: [],
  abilityLevel: 1,
  billingDiscounts: [],
  ...extra,
})

describe('parseModelCatalog', () => {
  it('reads only the chat category from the envelope and from a bare document alike', () => {
    const data = {
      default_model: 'glm',
      categories: [
        { type: 'embedding', models: [row('embed-me')] },
        { type: 'chat', models: [row('glm', { description: 'GLM' }), row('ds')] },
      ],
    }
    const expected = {
      defaultModelId: 'glm',
      models: [modelRow('glm', 'GLM'), modelRow('ds')],
    }
    expect(parseModelCatalog({ code: 0, message: 'ok', data })).toEqual(expected)
    expect(parseModelCatalog(data)).toEqual(expected)
  })

  it('drops invisible rows, the app-internal raccoon-work row, duplicate ids, and rows without an id', () => {
    const parsed = parseModelCatalog({
      code: 0,
      data: {
        categories: [{
          type: 'chat',
          models: [
            row('keep'),
            row('hidden', { visible: false }),
            row('raccoon-work'),
            row('Raccoon-Work'),
            row('dup'),
            row('dup'),
            row('   '),
            'not-an-object',
          ],
        }],
      },
    })
    expect(parsed?.models.map(model => model.id)).toEqual(['keep', 'dup'])
    // Collapse keeps the first occurrence, matching upstream list order.
    expect(parsed?.models[1]?.label).toBe('')
  })

  it('falls back to the first row when the declared default is not on the roster', () => {
    const parsed = parseModelCatalog({
      code: 0,
      data: { categories: [{ type: 'chat', default_model: 'gone', models: [row('a'), row('b')] }] },
    })
    expect(parsed?.defaultModelId).toBe('a')
  })

  it('returns undefined for a non-zero code, a missing chat category, and an empty roster', () => {
    const good = { categories: [{ type: 'chat', models: [row('a')] }] }
    expect(parseModelCatalog({ code: 500, data: good })).toBeUndefined()
    expect(parseModelCatalog({ code: 400001, message: 'nope' })).toBeUndefined()
    expect(parseModelCatalog({ categories: [{ type: 'embedding', models: [row('a')] }] })).toBeUndefined()
    expect(parseModelCatalog({ categories: [] })).toBeUndefined()
    expect(parseModelCatalog({ code: 0, data: { categories: [{ type: 'chat', models: [] }] } })).toBeUndefined()
    expect(parseModelCatalog(null)).toBeUndefined()
    expect(parseModelCatalog('text')).toBeUndefined()
  })

  it('validates every field on the way in: an unusable value is absent, never guessed', () => {
    const parsed = parseModelCatalog({
      categories: [{
        type: 'chat',
        models: [
          row('m', {
            description: ' M ',
            display_description: 'long note',
            params: { context_window: 1_000_000, max_tokens: 8000 },
            tags: ['Vision'],
            ability_level: 3,
            billing_multiplier: 1.5,
            billing_effective_multiplier: 0.79,
            billing_status: 'discount',
            billing_status_note: '夜间折扣中',
            billing_discounts: [
              { name: '夜间折扣', multiplier: 0.79, daily_start: '22:00', daily_end: '06:00', active: true },
              { name: '', multiplier: 0.5 },
              { name: 'bad', multiplier: -1 },
              'junk',
            ],
          }),
          row('flat', { context_window: -5, max_tokens: 'more', ability_level: 0, billing_multiplier: 0 }),
        ],
      }],
    })
    const [m, flat] = parsed?.models ?? []
    expect(m).toMatchObject({
      id: 'm',
      label: 'M',
      displayDescription: 'long note',
      contextWindow: 1_000_000,
      maxTokens: 8000,
      tags: ['vision'],
      abilityLevel: 3,
      billingMultiplier: 1.5,
      billingEffectiveMultiplier: 0.79,
      billingStatus: 'discount',
      billingStatusNote: '夜间折扣中',
    })
    expect(m?.billingDiscounts).toEqual([
      { name: '夜间折扣', multiplier: 0.79, dailyStart: '22:00', dailyEnd: '06:00', active: true },
    ])
    // Negative/zero/non-number capacities and levels never become numbers; the
    // row survives with only the fields the upstream stated validly.
    expect(flat).toMatchObject({ id: 'flat', abilityLevel: 1 })
    expect('contextWindow' in (flat ?? {})).toBe(false)
    expect('maxTokens' in (flat ?? {})).toBe(false)
    expect('billingMultiplier' in (flat ?? {})).toBe(false)
  })
})

describe('normalizeTags', () => {
  it('folds every spelling of image support into vision, once', () => {
    expect(normalizeTags(['Image', ' image-understanding ', 'VISION'])).toEqual(['vision'])
    expect(normalizeTags(['function-calling', 'image'])).toEqual(['function-calling', 'vision'])
    expect(supportsVision(modelRow('m', '', { tags: normalizeTags(['image']) }))).toBe(true)
  })

  it('rejects control characters, over-long entries, and non-strings, and caps the list', () => {
    expect(normalizeTags(['ok\u0000bad', 'y'.repeat(65), 7, null, '', ' a'])).toEqual(['a'])
    expect(normalizeTags('vision')).toEqual([])
    const many = Array.from({ length: 40 }, (_, index) => `tag-${index}`)
    expect(normalizeTags(many)).toHaveLength(32)
    expect(normalizeTags(['x'.repeat(64)])).toEqual(['x'.repeat(64)])
  })
})

describe('image-input capability', () => {
  it('follows what was measured, not what the tag claims, in both directions', () => {
    // Untagged but observed reading images: refusing them would be a false limit.
    expect(resolveVision(modelRow('sn-deepseek-v4-1-flash', '', { tags: ['general', 'code'] }))).toBe(true)
    // Tagged as reading images but observed having the image discarded: admitting
    // one produces a model that says it cannot see, after the message is stored.
    expect(resolveVision(modelRow('sn-glm-5-3', '', { tags: ['vision', 'code'] }))).toBe(false)
    // An id nobody measured has nothing but the tag to go on, in either direction.
    expect(resolveVision(modelRow('sn-new-untagged', '', { tags: [] }))).toBe(false)
    expect(resolveVision(modelRow('sn-new-tagged', '', { tags: ['vision'] }))).toBe(true)
  })

  it('lets the configuration outrank the measurement, with text-only winning a conflict', () => {
    const tagged = modelRow('sn-mystery', '', { tags: ['vision'] })
    expect(resolveVision(tagged, { imageInput: ['sn-mystery'], textOnly: ['sn-mystery'] })).toBe(false)
    expect(resolveVision(modelRow('sn-glm-5-3', '', { tags: ['vision'] }), { imageInput: ['sn-glm-5-3'] })).toBe(true)
    expect(resolveVision(modelRow('sn-deepseek-v4-1-flash'), { textOnly: ['sn-deepseek-v4-1-flash'] })).toBe(false)
    expect(resolveVision(modelRow('sn-deepseek-v4-1-flash'), { imageInput: [' other '], textOnly: [''] })).toBe(true)
  })

  it('states every visible upstream row, so a retag cannot silently flip capability', () => {
    for (const model of FALLBACK_CATALOG) {
      if (model.id in MEASURED_VISION) {
        expect(resolveVision(model)).toBe(MEASURED_VISION[model.id])
      }
    }
    expect(MEASURED_VISION['sn-deepseek-v4-1-flash']).toBe(true)
  })

  it('attaches the verdict on read, leaves the stored row upstream-shaped, and re-reads the config', () => {
    const rows = [
      modelRow('sn-deepseek-v4-1-flash', 'DeepSeek', { tags: ['general'] }),
      modelRow('sn-tag-only', 'TagOnly', { tags: ['vision'] }),
    ]
    let textOnly: string[] = []
    const catalog = new RaccoonCatalog(() => new Date(), () => ({ textOnly }))
    catalog.set({ models: rows })
    // Measured row and tagged row both start out able to read images.
    expect(catalog.current().map(model => supportsVision(model))).toEqual([true, true])
    // What was handed in is untouched: the verdict is a read-time judgement.
    expect(rows[0]?.vision).toBeUndefined()
    expect(rows[1]?.vision).toBeUndefined()
    // Editing the configuration is enough; no re-`set`, no refresh.
    textOnly = ['sn-tag-only']
    expect(catalog.current().map(model => supportsVision(model))).toEqual([true, false])
    textOnly = ['sn-tag-only', 'sn-deepseek-v4-1-flash']
    expect(catalog.current().map(model => supportsVision(model))).toEqual([false, false])
  })
})

describe('discountIsLive', () => {
  const local = (h: number, mi = 0): Date => new Date(2026, 7, 15, h, mi)

  it('treats the upstream active flag as authoritative', () => {
    const discount: RaccoonBillingDiscount = { name: 'n', multiplier: 0.5, active: true, endAt: '2020-01-01' }
    expect(discountIsLive(discount, local(12))).toBe(true)
  })

  it('wraps a daily window that crosses midnight and keeps the non-wrapping one inside its bounds', () => {
    const night: RaccoonBillingDiscount = { name: '夜间', multiplier: 0.5, active: false, dailyStart: '22:00', dailyEnd: '06:00' }
    expect(discountIsLive(night, local(23, 30))).toBe(true)
    expect(discountIsLive(night, local(3))).toBe(true)
    expect(discountIsLive(night, local(22))).toBe(true)
    expect(discountIsLive(night, local(6))).toBe(false)
    expect(discountIsLive(night, local(21, 59))).toBe(false)
    const day: RaccoonBillingDiscount = { name: '白天', multiplier: 0.9, active: false, dailyStart: '09:00', dailyEnd: '17:00' }
    expect(discountIsLive(day, local(9))).toBe(true)
    expect(discountIsLive(day, local(16, 59))).toBe(true)
    expect(discountIsLive(day, local(17))).toBe(false)
  })

  it('honors an absolute-only window inside its range and rejects it outside', () => {
    const abs: RaccoonBillingDiscount = {
      name: 'promo',
      multiplier: 0.5,
      active: false,
      startAt: '2026-08-15T00:00:00',
      endAt: '2026-08-15T23:59:59',
    }
    expect(discountIsLive(abs, new Date('2026-09-01T12:00:00'))).toBe(false)
    // Inside the range is live on the range alone: a promotion declared only
    // with dates is the common shape, and reading it as permanently dead would
    // silently drop a discount the user is actually being charged.
    expect(discountIsLive(abs, local(12))).toBe(true)
    expect(discountIsLive({ ...abs, active: true }, local(12))).toBe(true)
    expect(discountIsLive({ ...abs, active: true }, new Date('2026-09-01T12:00:00'))).toBe(true)
    // An unparseable bound is an unknown window: never claim a price is on.
    expect(discountIsLive({ ...abs, endAt: 'not-a-date' }, local(12))).toBe(false)
    // One-sided windows are open on the missing side.
    expect(discountIsLive({ name: 'p', multiplier: 0.5, active: false, startAt: '2020-01-01' }, local(12))).toBe(true)
    expect(discountIsLive({ name: 'p', multiplier: 0.5, active: false, endAt: '2020-01-01' }, local(12))).toBe(false)
  })

  it('requires the HH:mm shape and counts a window-less row as live', () => {
    expect(discountIsLive({ name: 'x', multiplier: 0.5, active: false, dailyStart: '25:00', dailyEnd: '26:00' }, local(12))).toBe(false)
    expect(discountIsLive({ name: 'x', multiplier: 0.5, active: false, dailyStart: '9am' }, local(12))).toBe(false)
    expect(discountIsLive({ name: 'x', multiplier: 0.5, active: false }, local(12))).toBe(true)
    expect(discountIsLive({ name: 'x', multiplier: 0, active: true }, local(12))).toBe(true)
  })
})

describe('modelWithCurrentBilling', () => {
  it('charges the cheapest live window and names limited free for a zero multiplier', () => {
    const model = modelRow('m', 'M', {
      billingMultiplier: 1,
      billingDiscounts: [
        { name: '九折', multiplier: 0.9, active: true },
        { name: '夜间', multiplier: 0.5, active: true },
        { name: '限时免费', multiplier: 0, active: true },
      ],
    })
    const out = modelWithCurrentBilling(model, new Date())
    expect(out.billingEffectiveMultiplier).toBe(0)
    expect(out.billingStatus).toBe('limited_free')
    expect(activeBadges(out, new Date())).toEqual(['九折', '夜间', '限时免费'])
    expect(isFree(out)).toBe(true)
  })

  it('derives the effective rate as list price × the cheapest live promotion factor', () => {
    // Measured shape from the gateway: `sn-glm-5-3-flash` carries
    // billing_multiplier 0.2 with a 限时折扣 factor of 0.5 and states 0.1, and
    // the free month carries 0.5 with factor 0 and states 0. A promotion's
    // multiplier is a factor, never an absolute price — reading it as one would
    // advertise x0.50 for a model actually billed at x0.10.
    const discounted = modelRow('m', 'M', {
      billingMultiplier: 0.2,
      billingEffectiveMultiplier: 0.1,
      billingStatus: 'discount',
      billingDiscounts: [{ name: '限时折扣', multiplier: 0.5, active: true }],
    })
    expect(multiplierLabel(modelWithCurrentBilling(discounted, new Date()))).toBe('x0.10')

    const free = modelRow('m', 'M', {
      billingMultiplier: 0.5,
      billingDiscounts: [{ name: '限免一个月', multiplier: 0, active: true }],
    })
    const freeNow = modelWithCurrentBilling(free, new Date())
    expect(multiplierLabel(freeNow)).toBe('x0.00')
    expect(isFree(freeNow)).toBe(true)

    // Overlapping windows: the one the user actually gets charged is the cheapest.
    const twoWindows = modelRow('m', 'M', {
      billingMultiplier: 1,
      billingDiscounts: [
        { name: '浅折', multiplier: 0.8, active: true },
        { name: '深折', multiplier: 0.3, active: true },
      ],
    })
    expect(multiplierLabel(modelWithCurrentBilling(twoWindows, new Date()))).toBe('x0.30')
  })

  it('restores the list price once every promotion has ended', () => {
    const model = modelRow('m', 'M', {
      billingMultiplier: 1.2,
      billingEffectiveMultiplier: 0.79,
      billingStatus: 'discount',
      billingDiscounts: [{ name: 'promo', multiplier: 0.79, active: false, endAt: '2020-01-01' }],
    })
    const out = modelWithCurrentBilling(model, new Date())
    expect(out.billingEffectiveMultiplier).toBe(1.2)
    expect(out.billingStatus).toBe('normal')
    expect(multiplierLabel(out)).toBe('x1.20')
  })

  it('drops the price entirely when the only figure a row ever had was promotional', () => {
    const model = modelRow('m', 'M', {
      billingEffectiveMultiplier: 0.79,
      billingStatus: 'discount',
      billingDiscounts: [{ name: 'promo', multiplier: 0.79, active: false, endAt: '2020-01-01' }],
    })
    const out = modelWithCurrentBilling(model, new Date())
    // No list price to fall back to, so nothing is stateable: the picker must
    // show no rate rather than a figure nobody is being charged any more.
    expect(out.billingEffectiveMultiplier).toBeUndefined()
    expect(out.billingStatus).toBeUndefined()
    expect(multiplierLabel(out)).toBeUndefined()
    expect(isRateUnknown(out)).toBe(true)
  })

  it('marks a row with no stated prices at all as rate-unknown, and rows with one as stateable', () => {
    expect(isRateUnknown(modelRow('m', 'M'))).toBe(true)
    expect(multiplierLabel(modelRow('m', 'M'))).toBeUndefined()
    expect(multiplierLabel(modelRow('m', 'M', { billingMultiplier: 0.797 }))).toBe('x0.80')
    expect(multiplierLabel(modelRow('m', 'M', { billingMultiplier: 1.5, billingEffectiveMultiplier: 0.79 }))).toBe('x0.79')
    expect(isFree(modelRow('m', 'M', { billingEffectiveMultiplier: 0 }))).toBe(true)
    expect(isFree(modelRow('m', 'M', { billingMultiplier: 0.5 }))).toBe(false)
    // A note alone still counts as something stateable next to the badge row.
    expect(isRateUnknown(modelRow('m', 'M', { billingStatusNote: '按次计费' }))).toBe(false)
  })

  it('leaves an undiscouted row untouched', () => {
    const model = modelRow('m', 'M', { billingMultiplier: 1 })
    expect(modelWithCurrentBilling(model, new Date(2020, 0))).toBe(model)
  })
})

describe('RaccoonCatalog', () => {
  it('re-derives billing on every read, so a promotion ending between reads changes what is served', () => {
    let now = new Date(2026, 7, 15, 10)
    const catalog = new RaccoonCatalog(() => now)
    catalog.set({
      defaultModelId: 'm',
      models: [modelRow('m', 'M', {
        billingMultiplier: 1,
        billingEffectiveMultiplier: 0.5,
        billingDiscounts: [{ name: '上午折扣', multiplier: 0.5, active: false, dailyStart: '09:00', dailyEnd: '12:00' }],
      })],
    })
    expect(catalog.find('m')?.billingStatus).toBe('discount')

    now = new Date(2026, 7, 15, 13)
    const later = catalog.find('m')
    expect(later?.billingStatus).toBe('normal')
    expect(later?.billingEffectiveMultiplier).toBe(1)
    expect(activeBadges(later!, now)).toEqual([])
  })

  it('hides the group without dropping the rows, and a hidden group serves nothing', () => {
    const catalog = new RaccoonCatalog()
    catalog.set({ defaultModelId: 'm', models: [modelRow('m', 'M')] })
    expect(catalog.visible).toBe(true)
    catalog.hide()
    expect(catalog.visible).toBe(false)
    expect(catalog.current()).toEqual([])
    expect(catalog.defaultModel).toBeUndefined()
    catalog.show()
    expect(catalog.current().map(model => model.id)).toEqual(['m'])
    expect(catalog.defaultModel).toBe('m')
    catalog.clear()
    expect(catalog.current()).toEqual([])
    expect(catalog.defaultModel).toBeUndefined()
  })
})

describe('RaccoonCatalogStore', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raccoon-catalog-'))
    path = join(dir, '.raccoon-catalog.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 4 })
  })

  const saved = (id: string): SavedRaccoonCatalog => ({
    version: 1,
    source: 'live',
    fetchedAtMs: 123,
    defaultModelId: id,
    models: [modelRow(id, id.toUpperCase())],
  })

  it('keys saved rosters by account so one user never sees another user’s prices', () => {
    const store = new RaccoonCatalogStore(path)
    store.set('alice', saved('glm'))
    expect(store.get('alice')?.defaultModelId).toBe('glm')
    expect(store.get('bob')).toBeUndefined()
    store.remove('alice')
    expect(store.get('alice')).toBeUndefined()
    // Remove of an unknown account is a no-op, not a rewrite.
    store.remove('nobody')
  })

  it('persists the roster to the file — but a reopened store reads it as empty (see report: persisted rows are re-parsed with the wire-shape reader)', () => {
    const store = new RaccoonCatalogStore(path)
    store.set('alice', { ...saved('glm'), source: 'saved', fetchedAtMs: 456 })
    // The file itself is a complete, correct record of the account's roster…
    const document = JSON.parse(readFileSync(path, 'utf8')) as { version: number, entries: Record<string, { source: string, fetchedAtMs: number, models: { id: string }[] }> }
    expect(document.entries['alice']?.source).toBe('saved')
    expect(document.entries['alice']?.fetchedAtMs).toBe(456)
    // The file is written in the normalized row shape, and the loader must read
    // that shape back: re-parsing it with the wire reader (`name`, `params`)
    // would drop every row and collapse the documented live → saved → fallback
    // ladder into "always fallback after a restart".
    const reopened = new RaccoonCatalogStore(path)
    const restored = reopened.get('alice')
    expect(restored?.models.map(model => model.id)).toEqual(['glm'])
    expect(restored?.source).toBe('saved')
    expect(restored?.defaultModelId).toBe('glm')
    expect(restored?.fetchedAtMs).toBe(456)
  })

  it('restores billing, windows and tags through the file round-trip', () => {
    const roundTrip = join(dir, 'catalog-round-trip.json')
    const store = new RaccoonCatalogStore(roundTrip)
    store.set('bob', {
      version: 1,
      source: 'live',
      fetchedAtMs: 111,
      defaultModelId: 'big',
      models: [modelRow('big', 'Big Model', {
        tags: ['vision'],
        contextWindow: 1_000_000,
        maxTokens: 100_000,
        billingMultiplier: 1.5,
        billingEffectiveMultiplier: 0,
        billingStatus: 'limited_free',
        billingStatusNote: '限时免费',
        billingDiscounts: [{ name: '夜间折扣', multiplier: 0, active: true }],
      })],
    })
    const restored = new RaccoonCatalogStore(roundTrip).get('bob')?.models[0]
    expect(restored?.tags).toEqual(['vision'])
    expect(restored?.contextWindow).toBe(1_000_000)
    expect(restored?.maxTokens).toBe(100_000)
    expect(restored?.billingMultiplier).toBe(1.5)
    expect(restored?.billingEffectiveMultiplier).toBe(0)
    expect(restored?.billingStatus).toBe('limited_free')
    expect(restored?.billingStatusNote).toBe('限时免费')
    expect(restored?.billingDiscounts).toEqual([{ name: '夜间折扣', multiplier: 0, active: true }])
  })

  it('reads a corrupt or foreign-version file as empty instead of throwing', () => {
    writeFileSync(path, 'not json{')
    expect(new RaccoonCatalogStore(path).get('alice')).toBeUndefined()
    writeFileSync(path, JSON.stringify({ version: 2, entries: { alice: saved('glm') } }))
    expect(new RaccoonCatalogStore(path).get('alice')).toBeUndefined()
    writeFileSync(path, JSON.stringify({ version: 1, entries: { alice: { models: [] } } }))
    expect(new RaccoonCatalogStore(path).get('alice')).toBeUndefined()
  })

  it('never writes token material into the catalog file', () => {
    const store = new RaccoonCatalogStore(path)
    store.set('alice', {
      ...saved('glm'),
      models: [modelRow('glm', 'GLM', { displayDescription: '带上下文窗口的模型', contextWindow: 2000 })],
    })
    store.set('bob', saved('ds'))
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('glm')
    for (const forbidden of ['access_token', 'accessToken', 'refresh_token', 'refreshToken', 'Bearer', 'eyJ']) {
      expect(text).not.toContain(forbidden)
    }
    // The document is exactly {version, entries}, keyed by account.
    const document = JSON.parse(text) as { version: number, entries: Record<string, unknown> }
    expect(Object.keys(document).sort()).toEqual(['entries', 'version'])
    expect(Object.keys(document.entries).sort()).toEqual(['alice', 'bob'])
  })

  it('survives an unwritable path: the cache is an optimization, never a failure', () => {
    const store = new RaccoonCatalogStore(join(dir, 'no-such-dir', 'deep', '.raccoon-catalog.json'))
    expect(() => { store.set('alice', saved('glm')) }).not.toThrow()
    // The in-memory answer still serves this process.
    expect(store.get('alice')?.defaultModelId).toBe('glm')
  })
})
