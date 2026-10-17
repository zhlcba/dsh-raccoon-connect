import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { modelWithCurrentBilling, type RaccoonCatalogModel } from '../src/catalog.ts'
import { probeFingerprint, PROBE_RECORD_TTL_MS, RaccoonProbeStore } from '../src/probe-store.ts'
import type { RaccoonProbeRecord } from '../src/probe-store.ts'

/**
 * The three guards on persisted probe answers — fingerprint, account, and
 * precedence — plus expiry. A sweep costs credit, so its record is worth
 * keeping; keeping it *unsafely* is worth nothing:
 *
 * - reuse requires the same account AND the same model shape (window, output
 *   ceiling, vision) AND a fresh-enough timestamp;
 * - a transient `unknown` never overwrites an earlier decisive answer: one
 *   network blip must not destroy a measurement that was paid for;
 * - losing the cache reads as empty, never as a throw at startup.
 */

const DAY = 24 * 60 * 60 * 1000

function model(overrides: {
  id?: string | undefined
  tags?: readonly string[] | undefined
  contextWindow?: number | undefined
  maxTokens?: number | undefined
} = {}): RaccoonCatalogModel {
  return {
    id: overrides.id ?? 'glm',
    label: 'GLM',
    visible: true,
    tags: overrides.tags ?? [],
    abilityLevel: 1,
    billingDiscounts: [],
    ...(overrides.contextWindow === undefined ? {} : { contextWindow: overrides.contextWindow }),
    ...(overrides.maxTokens === undefined ? {} : { maxTokens: overrides.maxTokens }),
  }
}

function record(overrides: {
  validation?: RaccoonProbeRecord['validation'] | undefined
  efforts?: readonly string[] | undefined
  probedAtMs?: number | undefined
  account?: string | undefined
  fingerprint?: string | undefined
} = {}): RaccoonProbeRecord {
  return {
    fingerprint: overrides.fingerprint ?? 'fp',
    validation: overrides.validation ?? 'validating',
    efforts: overrides.efforts ?? ['low', 'high'],
    probedAtMs: overrides.probedAtMs ?? 1000,
    pluginVersion: '0.1.0',
    account: overrides.account ?? 'alice',
  }
}

let dir: string
let path: string
let clock: { now: number }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'raccoon-probe-'))
  path = join(dir, '.raccoon-probe.json')
  clock = { now: 1_000_000 }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 4 })
})

const store = (): RaccoonProbeStore => new RaccoonProbeStore(path, () => clock.now)

describe('RaccoonProbeStore.get', () => {
  it('requires account, fingerprint, AND a live TTL — each miss reads as no record', () => {
    const s = store()
    expect(s.set('glm', record())).toBe(true)
    expect(s.get('alice', 'glm', 'fp')?.validation).toBe('validating')

    // Another account paid for nothing here.
    expect(s.get('bob', 'glm', 'fp')).toBeUndefined()
    // A changed model shape makes the old answer about a different thing.
    expect(s.get('alice', 'glm', 'other-fp')).toBeUndefined()
    // One day inside the 14-day window is still trusted…
    clock.now = 1_000_000 + PROBE_RECORD_TTL_MS - DAY
    expect(s.get('alice', 'glm', 'fp')).toBeDefined()
    // …and one past it is not: an upstream that validated in April is a fact
    // about April.
    clock.now = 1_000_000 + PROBE_RECORD_TTL_MS + 1
    expect(s.get('alice', 'glm', 'fp')).toBeUndefined()
    expect(PROBE_RECORD_TTL_MS).toBe(14 * DAY)
  })

  it('keys records by model id, not by any other model sharing the file', () => {
    const s = store()
    s.set('glm', record())
    expect(s.get('alice', 'ds', 'fp')).toBeUndefined()
  })
})

describe('RaccoonProbeStore.set precedence', () => {
  it('a transient unknown never overwrites the decisive record that was paid for', () => {
    const s = store()
    s.set('glm', record({ validation: 'validating', efforts: ['low'] }))
    expect(s.set('glm', record({ validation: 'unknown', efforts: [] }))).toBe(false)
    const kept = s.get('alice', 'glm', 'fp')
    expect(kept?.validation).toBe('validating')
    expect(kept?.efforts).toEqual(['low'])
  })

  it('decisive answers do replace each other, and unknowns replace unknowns', () => {
    const s = store()
    s.set('glm', record({ validation: 'unknown' }))
    expect(s.set('glm', record({ validation: 'unknown' }))).toBe(true)
    expect(s.set('glm', record({ validation: 'non-validating' }))).toBe(true)
    expect(s.get('alice', 'glm', 'fp')?.validation).toBe('non-validating')
    // After that, silence is once again refused — the new decisive record is
    // also money spent.
    expect(s.set('glm', record({ validation: 'unknown' }))).toBe(false)
  })
})

describe('RaccoonProbeStore file handling', () => {
  it('round-trips through a reopened store and persists exactly {version, records}', () => {
    const s = store()
    s.set('glm', record())
    s.set('ds', record({ validation: 'non-validating', efforts: [], account: 'bob', probedAtMs: 2000 }))
    const reopened = store()
    expect(reopened.get('alice', 'glm', 'fp')?.efforts).toEqual(['low', 'high'])
    expect(reopened.get('bob', 'ds', 'fp')?.validation).toBe('non-validating')
    const document = JSON.parse(readFileSync(path, 'utf8')) as { version: number, records: Record<string, unknown> }
    expect(document.version).toBe(1)
    expect(Object.keys(document.records).sort()).toEqual(['ds', 'glm'])
  })

  it('a corrupt, foreign-version, or malformed-shape file reads as empty without throwing', () => {
    writeFileSync(path, '{{{not json')
    expect(store().list()).toEqual([])
    writeFileSync(path, JSON.stringify({ version: 2, records: { glm: record() } }))
    expect(store().get('alice', 'glm', 'fp')).toBeUndefined()
    writeFileSync(path, JSON.stringify({ version: 1, records: { glm: { fingerprint: 7, validation: 'validating', efforts: [], probedAtMs: 1, account: 'a' } } }))
    expect(store().list()).toEqual([])
    // A non-object document at all, too.
    writeFileSync(path, '[1,2,3]')
    expect(store().list()).toEqual([])
  })

  it('never persists token material alongside probe records', () => {
    const s = store()
    s.set('glm', record({ efforts: ['low', 'medium'] }))
    const text = readFileSync(path, 'utf8')
    for (const forbidden of ['access_token', 'accessToken', 'refresh_token', 'Bearer', 'eyJ']) {
      expect(text).not.toContain(forbidden)
    }
  })
})

describe('RaccoonProbeStore.list / clear', () => {
  it('lists newest-first and can scope to one account', () => {
    const s = store()
    s.set('old', record({ probedAtMs: 100, account: 'alice' }))
    s.set('new', record({ probedAtMs: 900, account: 'alice' }))
    s.set('other', record({ probedAtMs: 500, account: 'bob' }))
    expect(s.list('alice').map(entry => entry.model)).toEqual(['new', 'old'])
    expect(s.list().map(entry => entry.model)).toEqual(['new', 'other', 'old'])
    s.clear()
    expect(s.list()).toEqual([])
    // The clear reached the file: a reopened store sees nothing.
    expect(store().list()).toEqual([])
  })
})

describe('probeFingerprint', () => {
  it('tracks exactly the model facts the observation was about', () => {
    const base = model()
    expect(probeFingerprint(base)).toBe(probeFingerprint(model()))
    expect(probeFingerprint(base)).not.toBe(probeFingerprint(model({ id: 'other' })))
    expect(probeFingerprint(base)).not.toBe(probeFingerprint(model({ contextWindow: 1000 })))
    expect(probeFingerprint(base)).not.toBe(probeFingerprint(model({ maxTokens: 100 })))
    expect(probeFingerprint(base)).not.toBe(probeFingerprint(model({ tags: ['vision'] })))
    // Only the capability facts feed the hash: an absent window and an
    // explicitly-omitted one are the same model shape, so the same record.
    expect(probeFingerprint(model({ contextWindow: undefined }))).toBe(probeFingerprint(base))
  })

  it('is stable across re-derived billing (a promo ending does not change the capability facts)', () => {
    const promo: RaccoonCatalogModel = {
      id: 'glm',
      label: 'GLM',
      visible: true,
      tags: [],
      abilityLevel: 1,
      billingMultiplier: 1,
      billingDiscounts: [{ name: 'p', multiplier: 0.5, active: false, endAt: '2020-01-01' }],
    }
    const settled = modelWithCurrentBilling(promo, new Date(2026, 7, 15))
    expect(settled.billingEffectiveMultiplier).toBe(1)
    expect(probeFingerprint(settled)).toBe(probeFingerprint(promo))
  })
})
