import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adoptIdentity, badgeRows, credentialPollMs, fetchCatalog, probeFingerprint, RaccoonCredentialStore, RaccoonUpstreamClient, sweep, visionOverridesOf } from '../src/index.ts'
import type { Config, Runtime } from '../src/index.ts'
import { FALLBACK_CATALOG, RaccoonCatalog, RaccoonCatalogStore } from '../src/catalog.ts'
import type { SavedRaccoonCatalog } from '../src/catalog.ts'
import { RaccoonProbeStore } from '../src/probe-store.ts'
import type { RaccoonProbeService } from '../src/probe-service.ts'
import { RACCOON_PRIMARY } from '../src/variants.ts'

/**
 * The lifecycle the plugin's named exports exist to make testable:
 * `adoptIdentity` / `fetchCatalog` / `sweep`.
 *
 * Pinned invariants:
 * - sign-in → live fetch → saved per account, and the group shows;
 * - an account switch (or any identity bump) during an in-flight fetch must
 *   not let the superseded answer land — the old fetch writes nothing;
 * - sign-out HIDES the group (an empty roster is how DSH hides a group) and
 *   the next account with no saved list stands up on `FALLBACK_CATALOG`;
 * - a failed fetch keeps the on-screen roster and records `error`, so the
 *   card can say "stale" instead of blanking;
 * - a same-account sweep does NOT re-fetch while live, but a failed fetch is
 *   retried after `CATALOG_RETRY_SWEEPS` poll intervals (`DSH_RACCOON_POLL_MS`
 *   under a faked clock).
 *
 * The runtime is wired by hand from the same exported pieces the private
 * `createRuntime` uses, against temp files with a stubbed `fetchImpl` — the
 * network is never touched and the real home directories never are.
 */

const MINUTE = 60_000
const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
const makeJwt = (claims: Record<string, unknown>): string => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`

/** A token well outside the five-minute refresh margin. */
const liveToken = (name: string): string => makeJwt({ iss: 'https://x', name, exp: Math.floor((Date.now() + 6 * 60 * MINUTE) / 1000) })
const accountOf = (name: string): string => `https://x:${name}`

const catalogBody = (id: string): string => JSON.stringify({
  code: 0,
  data: { default_model: id, categories: [{ type: 'chat', models: [{ name: id, description: id.toUpperCase(), params: { context_window: 4096 } }] }] },
})

let home: string
let desktopPath: string

/** Write a live desktop credential for one account name; returns the token. */
function signDesktopAs(name: string): string {
  const token = liveToken(name)
  writeFileSync(desktopPath, JSON.stringify({ access_token: token, refresh_token: makeJwt({ iss: 'https://x', name }) }))
  return token
}

/* ---------------------------- in-process gateway --------------------------- */

let fetchCalls: { url: string, headers: Record<string, string> }[]
let nextBody: string | undefined
let transportError: Error | undefined
let hang = false
let hangRelease: ((body: string) => void) | undefined
let onArrive: (() => void) | undefined

const fetchStub = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
  fetchCalls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
  if (transportError !== undefined) throw transportError
  if (hang) {
    onArrive?.()
    const body = await new Promise<string>(resolve => { hangRelease = resolve })
    hang = false
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response(nextBody ?? catalogBody('glm-live'), { status: 200, headers: { 'content-type': 'application/json' } })
})

/** Wait until the stubbed gateway has actually seen the in-flight request. */
function arrived(): Promise<void> {
  return new Promise(resolve => { onArrive = resolve })
}

/** Release the hung gateway request. */
function releaseFetch(body: string): void {
  const release = hangRelease
  hangRelease = undefined
  release?.(body)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'raccoon-index-'))
  const box = join(home, 'box')
  mkdirSync(box, { recursive: true })
  desktopPath = join(box, 'auth.json')
  fetchCalls = []
  nextBody = undefined
  transportError = undefined
  hang = false
  hangRelease = undefined
  onArrive = undefined
  for (const key of ['DSH_HOME', 'RACCOON_AUTH_FILE', 'BOX_AGENT_CONFIG_DIR', 'DSH_RACCOON_POLL_MS']) {
    savedEnv[key] = process.env[key]
  }
  process.env.DSH_HOME = home
})

const savedEnv: Record<string, string | undefined> = {}

afterEach(() => {
  vi.useRealTimers()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 4 })
})

/* ------------------------------- runtime wiring ---------------------------- */

function makeRuntime(): Runtime {
  const client = new RaccoonUpstreamClient({
    variant: RACCOON_PRIMARY,
    fetchImpl: fetchStub as unknown as typeof fetch,
    timeoutMs: 0, // streaming-style: no AbortController timers under a faked clock
  })
  const store = new RaccoonCredentialStore({
    variant: RACCOON_PRIMARY,
    desktopPath,
    ownPath: join(home, RACCOON_PRIMARY.ownFilename),
    refresh: token => client.refresh(token),
  })
  return {
    variant: RACCOON_PRIMARY,
    store,
    client,
    catalog: new RaccoonCatalog(),
    probeStore: new RaccoonProbeStore(join(home, RACCOON_PRIMARY.probeFilename)),
    savedCatalogs: new RaccoonCatalogStore(join(home, RACCOON_PRIMARY.catalogFilename)),
    // Unused by adoptIdentity/fetchCatalog/sweep; only the card route reads it.
    probeService: undefined as unknown as RaccoonProbeService,
    source: 'fallback',
    lastAttemptMs: 0,
    generation: 0,
    registered: false,
  }
}

/* ---------------------------------- tests ---------------------------------- */

describe('credentialPollMs', () => {
  it('honors a usable DSH_RACCOON_POLL_MS, clamps absurd lows, and caps highs', () => {
    delete process.env.DSH_RACCOON_POLL_MS
    expect(credentialPollMs()).toBe(30_000)
    process.env.DSH_RACCOON_POLL_MS = '500'
    expect(credentialPollMs()).toBe(500)
    process.env.DSH_RACCOON_POLL_MS = '50'
    expect(credentialPollMs()).toBe(30_000) // below the floor → the default, not a busy loop
    process.env.DSH_RACCOON_POLL_MS = 'not-a-number'
    expect(credentialPollMs()).toBe(30_000)
    process.env.DSH_RACCOON_POLL_MS = String(30 * 24 * 60 * 60 * 1000)
    expect(credentialPollMs()).toBe(24 * 60 * 60 * 1000)
  })
})

describe('sweep: sign-in, fetch, persist', () => {
  it('adopts a signed-in account, serves the live roster, and saves it for that account', async () => {
    const token = signDesktopAs('alice')
    const runtime = makeRuntime()
    await sweep(runtime)
    expect(runtime.account).toBe(accountOf('alice'))
    expect(runtime.source).toBe('live')
    expect(runtime.error).toBeUndefined()
    expect(runtime.fetchedAtMs).toBeGreaterThan(0)
    expect(runtime.catalog.visible).toBe(true)
    expect(runtime.catalog.current().map(model => model.id)).toEqual(['glm-live'])
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe(`${RACCOON_PRIMARY.llmBase}/model_catalog`)
    expect(fetchCalls[0]!.headers['Authorization']).toBe(`Bearer ${token}`)

    // Saved for the account alone: in-memory now, and on disk in the file
    // shape (a reopened store cannot read it back — reported defect in
    // RaccoonCatalogStore.load, covered in catalog.spec).
    expect(runtime.savedCatalogs.get(accountOf('alice'))?.models.map(model => model.id)).toEqual(['glm-live'])
    expect(runtime.savedCatalogs.get(accountOf('bob'))).toBeUndefined()
    const text = readFileSync(join(home, RACCOON_PRIMARY.catalogFilename), 'utf8')
    expect(text).toContain('glm-live')
    expect(text).toContain(accountOf('alice'))
    // The catalog file carries no token material even though the flow held one.
    expect(text).not.toContain('access_token')
    expect(text).not.toContain('refresh_token')
    expect(text).not.toContain('Bearer')
  })

  it('signs out by hiding the group and serving nothing, then stands a new account up on the fallback roster', async () => {
    signDesktopAs('alice')
    const runtime = makeRuntime()
    await sweep(runtime)
    expect(runtime.catalog.current().length).toBe(1)

    rmSync(desktopPath) // the app logged out
    await sweep(runtime)
    expect(runtime.account).toBeUndefined()
    expect(runtime.catalog.visible).toBe(false)
    expect(runtime.catalog.current()).toEqual([]) // hidden = empty roster = group gone

    // Bob signs in, has no saved catalog, and the fetch fails: he still sees
    // the compiled-in roster rather than an empty group or alice's models.
    signDesktopAs('bob')
    transportError = new Error('offline')
    await sweep(runtime)
    expect(runtime.account).toBe(accountOf('bob'))
    expect(runtime.catalog.visible).toBe(true)
    expect(runtime.catalog.current().map(model => model.id)).toEqual(FALLBACK_CATALOG.map(model => model.id))
    expect(runtime.source).toBe('fallback')
    expect(runtime.error).toBe('offline')
  })
})

describe('probe observations across an identity adoption', () => {
  const probed = { id: 'glm', label: 'GLM', visible: true, tags: ['vision'], abilityLevel: 1, billingDiscounts: [] } as const

  it('survives the cold-start adoption of the account that paid for it', () => {
    const runtime = makeRuntime()
    const account = accountOf('alice')
    const fingerprint = probeFingerprint(probed)
    runtime.probeStore.set(probed.id, {
      fingerprint, validation: 'validating', efforts: ['low', 'high'], probedAtMs: Date.now(), pluginVersion: 'test', account,
    })
    // The boot sequence exactly as sweep() drives it: nothing known, then the
    // account the file already belongs to.
    adoptIdentity(runtime, undefined)
    adoptIdentity(runtime, account)
    expect(runtime.probeStore.get(account, probed.id, fingerprint)?.efforts).toEqual(['low', 'high'])
  })

  it('still refuses to hand one account the sweep another paid for', () => {
    const runtime = makeRuntime()
    const fingerprint = probeFingerprint(probed)
    runtime.probeStore.set(probed.id, {
      fingerprint, validation: 'validating', efforts: ['low'], probedAtMs: Date.now(), pluginVersion: 'test', account: accountOf('alice'),
    })
    adoptIdentity(runtime, accountOf('bob'))
    expect(runtime.probeStore.get(accountOf('bob'), probed.id, fingerprint)).toBeUndefined()
  })
})

describe('fetchCatalog: superseded answers', () => {
  it('an account switch mid-fetch keeps the old account’s roster from landing', async () => {
    signDesktopAs('alice')
    const runtime = makeRuntime()
    adoptIdentity(runtime, accountOf('alice'))
    hang = true
    const done = arrived()
    const inflight = fetchCatalog(runtime, accountOf('alice'))
    await done
    expect(fetchCalls).toHaveLength(1)

    // Bob takes the machine while alice's fetch is on the wire.
    signDesktopAs('bob')
    adoptIdentity(runtime, accountOf('bob'))
    const beforeCatalog = runtime.catalog.current().map(model => model.id)
    releaseFetch(catalogBody('alice-only'))
    await inflight

    expect(runtime.catalog.current().map(model => model.id)).toEqual(beforeCatalog)
    expect(runtime.source).toBe('fallback')
    expect(runtime.error).toBeUndefined() // a dropped answer is not a failure
    const persisted = new RaccoonCatalogStore(join(home, RACCOON_PRIMARY.catalogFilename))
    expect(persisted.get(accountOf('alice'))).toBeUndefined()
    expect(persisted.get(accountOf('bob'))).toBeUndefined()
  })

  it('a generation bump for the SAME account also voids the older fetch', async () => {
    // Identity alone would pass here — two fetches for one account can still
    // finish out of order — so the generation must be the backstop.
    signDesktopAs('alice')
    const runtime = makeRuntime()
    runtime.savedCatalogs.set(accountOf('alice'), {
      version: 1,
      source: 'saved',
      fetchedAtMs: 5,
      defaultModelId: 'saved-model',
      models: [{ id: 'saved-model', label: 'Saved', visible: true, tags: [], abilityLevel: 1, billingDiscounts: [] }],
    } satisfies SavedRaccoonCatalog)
    adoptIdentity(runtime, accountOf('alice'))
    expect(runtime.source).toBe('saved')

    hang = true
    const done = arrived()
    const inflight = fetchCatalog(runtime, accountOf('alice'))
    await done
    adoptIdentity(runtime, accountOf('alice')) // same account, fresh generation
    releaseFetch(catalogBody('stale-live'))
    await inflight
    expect(runtime.catalog.current().map(model => model.id)).toEqual(['saved-model'])
    expect(runtime.source).toBe('saved')
  })
})

describe('fetchCatalog: failure and retry policy', () => {
  it('a failed fetch keeps the saved roster and records the error', async () => {
    signDesktopAs('alice')
    const runtime = makeRuntime()
    runtime.savedCatalogs.set(accountOf('alice'), {
      version: 1,
      source: 'saved',
      fetchedAtMs: 7,
      defaultModelId: 'saved-model',
      models: [{ id: 'saved-model', label: 'Saved', visible: true, tags: [], abilityLevel: 1, billingDiscounts: [] }],
    } satisfies SavedRaccoonCatalog)
    transportError = new Error('offline')
    await sweep(runtime)
    expect(runtime.source).toBe('saved') // before the fetch resolves the save is what is on screen…
    // …this fetch fails, and the on-screen roster survives it:
    expect(runtime.catalog.current().map(model => model.id)).toEqual(['saved-model'])
    expect(runtime.error).toBe('offline')
    expect(runtime.fetchedAtMs).toBe(7)
    expect(runtime.catalog.visible).toBe(true)
  })

  it('a live catalog is not re-fetched by same-account sweeps, however many', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }) // starts at the real now; the 6h tokens stay live
    signDesktopAs('alice')
    const runtime = makeRuntime()
    await sweep(runtime)
    expect(fetchCalls).toHaveLength(1)
    for (let tick = 0; tick < 40; tick += 1) {
      vi.advanceTimersByTime(60_000)
      await sweep(runtime)
    }
    expect(fetchCalls).toHaveLength(1)
  })

  it('a failed fetch is retried after CATALOG_RETRY_SWEEPS intervals and not before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }) // starts at the real now; the 6h tokens stay live
    process.env.DSH_RACCOON_POLL_MS = '1000' // retry gate: 10 × 1000 ms
    signDesktopAs('alice')
    transportError = new Error('offline')
    const runtime = makeRuntime()
    await sweep(runtime) // sign-in sweep: attempt 1, fails
    expect(fetchCalls).toHaveLength(1)
    expect(runtime.source).toBe('fallback')

    vi.advanceTimersByTime(9_000)
    await sweep(runtime)
    expect(fetchCalls).toHaveLength(1) // still inside the retry window

    vi.advanceTimersByTime(1_000) // exactly 10 intervals after the last attempt
    transportError = undefined // the network came back
    await sweep(runtime)
    expect(fetchCalls).toHaveLength(2)
    expect(runtime.source).toBe('live')
    expect(runtime.error).toBeUndefined()
    expect(runtime.catalog.current().map(model => model.id)).toEqual(['glm-live'])
  })

  it('joins a concurrent same-account fetch instead of firing a second request', async () => {
    signDesktopAs('alice')
    const runtime = makeRuntime()
    adoptIdentity(runtime, accountOf('alice'))
    hang = true
    const first = arrived()
    const a = fetchCatalog(runtime, accountOf('alice'))
    await first
    expect(fetchCalls).toHaveLength(1)
    const b = fetchCatalog(runtime, accountOf('alice'))
    releaseFetch(catalogBody('glm-live'))
    await Promise.all([a, b])
    expect(fetchCalls).toHaveLength(1)
    expect(runtime.source).toBe('live')
  })
})

describe('badgeRows', () => {
  it('states the rate, the badges, capacity, and vision — or honestly says unknown', () => {
    const catalog = new RaccoonCatalog(() => new Date(2026, 7, 15, 12))
    catalog.set({
      models: [
        { id: 'priced', label: 'Priced', visible: true, tags: ['vision'], abilityLevel: 1, contextWindow: 1000, maxTokens: 100, billingMultiplier: 1, billingDiscounts: [{ name: '限时免费', multiplier: 0.79, active: true }] },
        { id: 'bare', label: '', visible: true, tags: [], abilityLevel: 1, billingDiscounts: [] },
      ],
    })
    const rows = badgeRows(catalog, new Date(2026, 7, 15, 12))
    expect(rows).toEqual([
      { id: 'priced', name: 'Priced', credits: 'x0.79', badges: ['限时免费'], contextWindow: 1000, maxTokens: 100, vision: true },
      { id: 'bare', name: 'bare', rateUnknown: true, badges: [], vision: false },
    ])
  })

  it('states the resolved verdict rather than the raw tag, configuration included', () => {
    const config: Config = { visionModelIds: [], textOnlyModelIds: ['  sn-tagged ', ''] }
    const catalog = new RaccoonCatalog(() => new Date(2026, 7, 15, 12), () => visionOverridesOf(config))
    catalog.set({
      models: [
        // No `vision` tag, but measured reading images.
        { id: 'sn-deepseek-v4-1-flash', label: 'DeepSeek', visible: true, tags: ['general'], abilityLevel: 1, billingDiscounts: [] },
        // Tagged, and the user says otherwise — a blank entry in the same list
        // must not switch anything else off.
        { id: 'sn-tagged', label: 'Tagged', visible: true, tags: ['vision'], abilityLevel: 1, billingDiscounts: [] },
      ],
    })
    expect(badgeRows(catalog).map(row => [row.id, row.vision])).toEqual([
      ['sn-deepseek-v4-1-flash', true],
      ['sn-tagged', false],
    ])
  })
})
