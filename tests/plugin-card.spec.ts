import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RACCOON_PROBE_PATH, RACCOON_STATUS_PATH } from '../src/status-paths.ts'
import { RaccoonPluginCard } from '../src/client/RaccoonPluginCard.tsx'
import { en } from '../src/client/locales.ts'

/**
 * Card tests, ported from the reference plugin's suite plus the invariants
 * this card's own design rests on.
 *
 * Pinned here because a regression in each was a real defect in the reference
 * lineage or is a stated contract of this plugin:
 * - a card-wide `busy` flag must not drive per-model button labels;
 * - the paid-detection confirmation belongs to the row that asked for it;
 * - a failed poll ANNOTATES the document on screen, it never blanks it;
 * - newest-read-wins: a slow older response must not overwrite a newer one
 *   (the `readSeq` monotonic sequence ref);
 * - `rateUnknown` renders as "price unknown", never as a stale number or as
 *   free; signed-out hides the model sections and shows the reason;
 * - probe writes carry the `X-Raccoon-Probe-Key` header the host guards on.
 *
 * The card is driven through `react-test-renderer` with a stubbed `fetch` and
 * a stubbed `window`; no request leaves the process.
 */

/** Locale lookup mirroring the injected `t` (params substituted, as the host does). */
const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

/** `en.statusRefreshFailed` up to its `{message}` slot: the annotation prefix. */
const NOTICE = en.statusRefreshFailed.split('{message}')[0]!

type Reply = {
  ok?: boolean
  status?: number
  body?: unknown
  /** A 200 whose body is not JSON at all (a proxy page, an HTML fallback). */
  invalidJson?: true
}
/** `{ hang: true }` leaves the request pending, so a test owns when it settles. */
type Step = Reply | { hang: true }

/* -------------------------------------------------------------------------- *
 * Harness: a recording fetch and a controllable `window`
 * -------------------------------------------------------------------------- */

const calls: { url: string, init: RequestInit | undefined }[] = []
const hung = new Map<number, (reply: Reply) => void>()
let statusReply: Step = { ok: true, body: {} }
let writeReply: Step = { ok: true, body: {} }
/** Overrides the default method-based reply, e.g. to answer by arrival order. */
let plan: ((url: string, init: RequestInit | undefined, index: number) => Step) | undefined

const intervals = new Map<number, () => void>()
const clearedHandles: number[] = []
let nextHandle = 1

function makeResponse(reply: Reply): Response {
  const ok = reply.ok ?? true
  return {
    ok,
    status: reply.status ?? (ok ? 200 : 500),
    json: async () => {
      if (reply.invalidJson === true) throw new SyntaxError('Unexpected token < in JSON at position 0')
      return reply.body
    },
  } as unknown as Response
}

/** Record `(url, init)` for every request and answer it in process. */
function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const index = calls.length
    calls.push({ url: String(input), init })
    const step = plan?.(String(input), init, index)
      ?? (init?.method === 'POST' ? writeReply : statusReply)
    if ('hang' in step) {
      return await new Promise<Response>(resolve => {
        hung.set(index, reply => { resolve(makeResponse(reply)) })
      })
    }
    return makeResponse(step)
  }))
}

/** A window stub whose intervals the test can fire itself. */
function stubWindow(): void {
  vi.stubGlobal('window', {
    setInterval: (handler: () => void) => {
      const handle = nextHandle++
      intervals.set(handle, handler)
      return handle
    },
    clearInterval: (handle: number) => {
      clearedHandles.push(handle)
      intervals.delete(handle)
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
}

/** Settle a request that was held open, and flush the state it produces. */
async function release(index: number, reply: Reply): Promise<void> {
  const resolve = hung.get(index)
  if (resolve === undefined) throw new Error(`no request held open at index ${index}`)
  hung.delete(index)
  await act(async () => { resolve(reply) })
}

/** Fire every armed interval once (the card's 60s poll). */
async function tickIntervals(): Promise<void> {
  const handlers = [...intervals.values()]
  await act(async () => { for (const handler of handlers) handler() })
}

/** One signed-in status document, as the host sends it. */
function signedInStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'signed-in',
    nickname: 'nick',
    probeKey: 'test-key',
    // The refresh-model-list button sits on the catalog row; a signed-in host
    // essentially always sends the provenance, so the default carries it.
    catalog: { source: 'live', fetchedAt: Date.UTC(2026, 8, 12, 8, 30) },
    models: [],
    ...overrides,
  }
}

describe('Raccoon plugin card', () => {
  let view: ReactTestRenderer | undefined

  beforeEach(() => {
    calls.length = 0
    hung.clear()
    intervals.clear()
    clearedHandles.length = 0
    nextHandle = 1
    plan = undefined
    statusReply = { ok: true, body: signedInStatus({
      probe: {
        consent: true,
        running: false,
        candidates: ['hy3', 'glm-5.2', 'minimax-m3'],
        results: [],
      },
    }) }
    writeReply = { ok: true, body: { state: 'ok', validation: 'non-validating', efforts: [] } }
    stubFetch()
    stubWindow()
  })

  afterEach(() => {
    act(() => { view?.unmount() })
    view = undefined
    vi.unstubAllGlobals()
  })

  /**
   * Every rendered string, in document order.
   *
   * A traversal, not `JSON.stringify`: stringifying escapes the Chinese copy
   * (and the variant name) out of reach of `toContain`, while a depth-first
   * join keeps both the raw text and the order the row-placement assertions
   * depend on.
   */
  const rendered = (): string => {
    const parts: string[] = []
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        parts.push(node)
        return
      }
      if (Array.isArray(node)) {
        for (const child of node) walk(child)
        return
      }
      if (typeof node === 'object' && node !== null) walk((node as { children?: unknown }).children)
    }
    walk(view!.toJSON())
    return parts.join('|')
  }
  const buttons = () => view!.root.findAllByType('button')
  const labels = (): string[] => buttons().map(node => node.children.join(''))

  /** Mount the card and expand it: expanding is what starts the first read. */
  async function mount(): Promise<void> {
    await act(async () => {
      // The card reads only `t` (and `variant`, which defaults); the rest of
      // the props belong to the slot that mounts it in DSH.
      const props = { t } as unknown as Parameters<typeof RaccoonPluginCard>[0]
      view = create(createElement(RaccoonPluginCard, props))
    })
    await act(async () => { buttons()[0]!.props.onClick() })
  }

  /**
   * Press a button by its label. `nth` disambiguates labels that repeat once
   * every row carries its own button (all idle rows read "Detect").
   */
  async function press(label: string, nth = 0): Promise<void> {
    const matches = buttons().filter(node => node.children.join('') === label)
    const node = matches[nth]
    if (node === undefined) {
      throw new Error(`no button #${nth} labelled ${label}; have: ${labels().join(' | ')}`)
    }
    await act(async () => { node.props.onClick() })
  }

  /* ---------------- probe section (reference-lineage regressions) --------- */

  it('labels only the pressed model as running', async () => {
    // Regression: a card-wide `busy` flag drove the label, so starting one
    // detection made all three candidate buttons read "Detecting …".
    plan = (_url, init) => (init?.method === 'POST' ? { hang: true } : statusReply)
    await mount()
    await press(en.probeStart, 0)
    await press(en.probeConfirmAction)

    const running = labels().filter(label => label.startsWith('Detecting'))
    // Exactly one row reports progress, and its label names the model.
    expect(running).toHaveLength(1)
    expect(running[0]).toContain('hy3')
    // The other rows keep their idle label.
    expect(labels().filter(label => label === en.probeStart)).toHaveLength(2)
  })

  it('returns the button to its idle label once the run finishes', async () => {
    plan = (_url, init) => (init?.method === 'POST' ? { hang: true } : statusReply)
    await mount()
    await press(en.probeStart, 0)
    await press(en.probeConfirmAction)
    expect(labels().filter(label => label.startsWith('Detecting'))).toHaveLength(1)

    // Release the held POST; the running label must clear.
    await release(1, { ok: true, body: { state: 'ok', validation: 'non-validating', efforts: [] } })
    expect(labels().filter(label => label.startsWith('Detecting'))).toHaveLength(0)
    expect(labels().filter(label => label === en.probeStart)).toHaveLength(3)
  })

  it('shows the confirmation inside the row that asked for it', async () => {
    await mount()

    // Open the confirmation for the FIRST candidate.
    await press(en.probeStart, 0)
    const confirmBody = en.probeConfirmBody.replace('{model}', 'hy3').slice(0, 12)
    expect(rendered()).toContain(confirmBody)

    // It belongs to the first row, i.e. it precedes the later candidates in
    // document order rather than trailing the list.
    const tree = rendered()
    expect(tree.indexOf(confirmBody)).toBeLessThan(tree.indexOf('minimax-m3'))
  })

  it('keeps a detected model in the candidate list, relabelled', async () => {
    // Regression: a detected model used to leave the candidate list, so its
    // button vanished and re-running it meant clearing every other result.
    statusReply = { ok: true, body: signedInStatus({
      probe: {
        consent: true,
        running: false,
        candidates: ['hy3', 'glm-5.2'],
        results: [{ id: 'hy3', name: 'Hy3', validation: 'non-validating', efforts: [], probedAt: Date.now() }],
      },
    }) }
    await mount()
    // Both rows are present. The detected one offers a re-run, the other a
    // first run — and neither row disappeared.
    expect(rendered()).toContain('Hy3')
    expect(rendered()).toContain('glm-5.2')
    expect(labels()).toContain(en.probeRedetect)
    expect(labels()).toContain(en.probeStart)
  })

  it('shows the same list before and after a detection', async () => {
    await mount()
    expect(labels().filter(label => label === en.probeStart)).toHaveLength(3)

    // Simulate the host reporting a result for hy3 without removing it from
    // the candidate list, which is how the host behaves.
    statusReply = { ok: true, body: signedInStatus({
      probe: {
        consent: true,
        running: false,
        candidates: ['hy3', 'glm-5.2', 'minimax-m3'],
        results: [{ id: 'hy3', name: 'Hy3', validation: 'non-validating', efforts: [], probedAt: Date.now() }],
      },
    }) }
    await press(en.refresh)
    // Still three rows: one re-run, two first runs.
    expect(labels()).toContain(en.probeRedetect)
    expect(labels().filter(label => label === en.probeStart)).toHaveLength(2)
  })

  it('reports the consent gate and the credit caveat before any spend', async () => {
    await mount()
    // consent=true: the authorized wording, plus the per-run credit warning.
    expect(rendered()).toContain(en.probeConsentOn)
    expect(rendered()).toContain(en.probeConsentHint)

    statusReply = { ok: true, body: signedInStatus({
      probe: { consent: false, running: false, candidates: ['hy3'], results: [] },
    }) }
    await press(en.refresh)
    expect(rendered()).toContain(en.probeConsentOff)
  })

  /* ------------------------------ routes and key ------------------------- */

  it('sends the probe key header and the refresh action to the probe route', async () => {
    await mount()
    await press(en.refreshModels)

    const post = calls.find(call => call.init?.method === 'POST')
    expect(post).toBeDefined()
    expect(post!.url).toBe(RACCOON_PROBE_PATH)
    // The exact spelling the host guard is written against: a drift here is a
    // 403 on every write, silent on every read.
    expect((post!.init!.headers as Record<string, string>)['X-Raccoon-Probe-Key']).toBe('test-key')
    expect(JSON.parse(String(post!.init!.body))).toEqual({ action: 'refresh' })
  })

  /* --------------------- catalog provenance and models ------------------- */

  it('distinguishes the live, saved, and built-in-fallback catalog sources', async () => {
    const fetchedAt = Date.UTC(2026, 8, 12, 8, 30)
    statusReply = { ok: true, body: signedInStatus({ catalog: { source: 'saved', fetchedAt } }) }
    await mount()
    expect(rendered()).toContain(t('catalogSourceLine', { source: en.catalogSourceSaved }))
    expect(rendered()).not.toContain(t('catalogSourceLine', { source: en.catalogSourceFallback }))

    statusReply = { ok: true, body: signedInStatus({ catalog: { source: 'live', fetchedAt } }) }
    await press(en.refresh)
    expect(rendered()).toContain(t('catalogSourceLine', { source: en.catalogSourceLive }))

    statusReply = { ok: true, body: signedInStatus({ catalog: { source: 'fallback' } }) }
    await press(en.refresh)
    expect(rendered()).toContain(t('catalogSourceLine', { source: en.catalogSourceFallback }))
  })

  it('renders the redacted reason of the last failed catalog fetch', async () => {
    statusReply = { ok: true, body: signedInStatus({
      catalog: { source: 'saved', fetchedAt: Date.UTC(2026, 8, 12), error: 'upstream timeout' },
    }) }
    await mount()
    expect(rendered()).toContain(t('catalogError', { message: 'upstream timeout' }))
  })

  it('renders identity, credential source, and both token expiries', async () => {
    statusReply = { ok: true, body: signedInStatus({
      identity: 'personal',
      source: 'desktop',
      expiresAt: Date.UTC(2026, 8, 13, 9, 0),
      refreshExpiresAt: Date.UTC(2026, 12, 1, 9, 0),
    }) }
    await mount()
    let text = rendered()
    expect(text).toContain(en.identityPersonal)
    expect(text).toContain(t('sourceDesktop', { name: '商汤小浣熊' }))
    expect(text).toContain(en.accessTokenExpires.split('{time}')[0]!)
    expect(text).toContain(en.refreshTokenExpires.split('{time}')[0]!)

    statusReply = { ok: true, body: signedInStatus({
      identity: 'org-unit-7', orgName: 'SenseTime', source: 'dsh',
    }) }
    await press(en.refresh)
    text = rendered()
    expect(text).toContain(t('identityOrg', { identity: 'org-unit-7' }))
    expect(text).toContain(t('orgName', { name: 'SenseTime' }))
    expect(text).toContain(en.sourceDsh)
  })

  it('states the credit balance and plan, or the lookup error, on the details tab', async () => {
    statusReply = { ok: true, body: signedInStatus({
      points: { total: 1250, plan: 'Pro', note: 'plan renews monthly' },
    }) }
    await mount()
    await press(t('tabDetails'))
    let text = rendered()
    expect(text).toContain(t('pointsTotal', { total: new Intl.NumberFormat(undefined).format(1250) }))
    expect(text).toContain(t('pointsPlan', { plan: 'Pro' }))
    expect(text).toContain(t('pointsNote', { note: 'plan renews monthly' }))

    statusReply = { ok: true, body: signedInStatus({ pointsError: 'billing endpoint 503' }) }
    await press(t('tabStatus'))
    await press(en.refresh)
    await press(t('tabDetails'))
    text = rendered()
    expect(text).toContain(t('pointsError', { message: 'billing endpoint 503' }))
  })

  it('renders a rateUnknown model as price unknown, never as free or a stale number', async () => {
    statusReply = { ok: true, body: signedInStatus({
      models: [
        { id: 'm-unknown', name: 'M Unknown', rateUnknown: true, free: false },
        { id: 'm-known', name: 'M Known', credits: 'x0.79', badges: ['夜间折扣'] },
      ],
    }) }
    await mount()
    await press(t('tabDetails'))
    const text = rendered()
    // The withheld rate must say so; silence or a `free` chip next to a
    // promotion that has ended is the false claim this field exists to avoid.
    expect(text).toContain(en.rateUnknown)
    expect(text).toContain(t('rate', { rate: 'x0.79' }))
    expect(text).toContain(en.badgeNightDiscount)
    // The rateUnknown row itself is not rendered as free: `Free` appears only
    // as a chip for `free: true` models, and this document has none.
    expect(text).not.toContain(en.freeModel)
  })

  it('lists context window, max output, and vision on the context tab', async () => {
    statusReply = { ok: true, body: signedInStatus({
      models: [
        { id: 'm-big', name: 'M Big', contextWindow: 1_000_000, maxTokens: 8000, vision: true },
        { id: 'm-small', name: 'M Small', contextWindow: 200_000, vision: false },
        { id: 'm-bare', name: 'M Bare' },
      ],
    }) }
    await mount()
    await press(t('tabContext'))
    const text = rendered()
    expect(text).toContain(t('contextWindow', { size: '1M' }))
    expect(text).toContain(t('contextMaxOutput', { size: '8K' }))
    expect(text).toContain(t('contextWindow', { size: '200K' }))
    expect(text).toContain(en.visionYes)
    expect(text).toContain(en.visionNo)
    // A model the catalog gave no capacity for is simply absent: the tab
    // states upstream numbers, never a fabricated default.
    expect(text).not.toContain('M Bare')
    // Largest window first.
    expect(text.indexOf('M Big')).toBeLessThan(text.indexOf('M Small'))
  })

  /* --------------------- read policies (the card's core) ------------------ */

  it('shows the loading label, not a signed-out claim, before the first response', async () => {
    statusReply = { hang: true }
    await mount()

    const text = rendered()
    expect(text).toContain(en.loading)
    expect(text).not.toContain(en.signedOut)
    expect(text).not.toContain(en.requestFailed)
  })

  it('renders an error state for a 200 whose body is literal null, without throwing', async () => {
    // The host answered 200 with `null`: `.json()` resolves to null and an
    // unchecked cast stored it, so the next render dereferenced `status.status`.
    statusReply = { ok: true, body: null }
    await mount()

    expect(rendered()).toContain(en.requestFailed)
    expect(rendered()).toContain(en.statusResponseInvalid)
    // The card stays operable rather than crashing the plugin slot.
    expect(labels()).toContain(en.refresh)
  })

  it('keeps every rendered value and adds the notice after a failed poll', async () => {
    const document = signedInStatus({
      nickname: 'nick',
      catalog: { source: 'live', fetchedAt: Date.UTC(2026, 8, 12, 8, 30) },
      points: { total: 15 },
    })
    statusReply = { ok: true, body: document }
    await mount()
    expect(rendered()).toContain('nick')
    expect(rendered()).toContain(t('catalogSourceLine', { source: en.catalogSourceLive }))
    // Points are reference detail; switch tabs, then let the poll fail. The
    // annotation must survive a tab that the status line does not live on.
    await press(t('tabDetails'))
    expect(rendered()).toContain(t('pointsTotal', { total: new Intl.NumberFormat(undefined).format(15) }))

    // The poll fails. Before the fix this replaced the document with
    // `{ status: 'error' }`, taking the account, credit and catalog with it.
    statusReply = { ok: false, status: 500, body: {} }
    await tickIntervals()

    const failed = rendered()
    expect(failed).toContain('nick')
    expect(failed).toContain(t('pointsTotal', { total: new Intl.NumberFormat(undefined).format(15) }))
    expect(failed).toContain(NOTICE)
    expect(failed).toContain('HTTP 500')
    // The label still describes the account, not the failed read.
    expect(failed).not.toContain(en.requestFailed)
    // The other tab's content rode out the failure too: the document was
    // annotated, never discarded.
    await press(t('tabStatus'))
    expect(rendered()).toContain(t('catalogSourceLine', { source: en.catalogSourceLive }))
  })

  it('clears the notice after the next successful read and keeps the poll armed', async () => {
    await mount()
    const handle = [...intervals.keys()][0]!
    statusReply = { ok: false, status: 500, body: {} }
    await tickIntervals()
    expect(rendered()).toContain(NOTICE)
    // A failed read cannot disarm the interval: one transient error must not
    // leave the card stale until the user clicks Refresh.
    expect([...intervals.keys()]).toEqual([handle])

    statusReply = { ok: true, body: signedInStatus({ nickname: 'healed' }) }
    await tickIntervals()
    expect(rendered()).toContain('healed')
    expect(rendered()).not.toContain(NOTICE)
  })

  it('still stops the poll when the upstream answers signed-out', async () => {
    await mount()
    const handle = [...intervals.keys()][0]!
    expect(intervals.size).toBe(1)

    statusReply = { ok: true, body: { status: 'signed-out' } }
    await tickIntervals()

    // A genuine signed-out answer is not a transient failure: the user's
    // Refresh button is the only thing that can change it.
    expect(intervals.size).toBe(0)
    expect(clearedHandles).toContain(handle)
    expect(rendered()).toContain(en.signedOut)
  })

  it('renders the signed-out reason and hides the model sections', async () => {
    // For 小浣熊 the actionable case: the single-use refresh token was rotated
    // elsewhere and the desktop app has to be opened once. The reason replaces
    // the generic hint, and no empty roster stands in for it.
    statusReply = { ok: true, body: { status: 'signed-out', reason: 'Open 商汤小浣熊 once to sign in again.' } }
    await mount()

    const text = rendered()
    expect(text).toContain('Open 商汤小浣熊 once to sign in again.')
    expect(text).not.toContain(en.signedOutHint.replace('{name}', '商汤小浣熊'))
    expect(labels()).not.toContain(en.tabStatus)
    expect(labels()).not.toContain(en.tabContext)
    expect(labels()).not.toContain(en.tabDetails)
  })

  it('falls back to the desktop-app hint when signed-out gives no reason', async () => {
    statusReply = { ok: true, body: { status: 'signed-out' } }
    await mount()
    expect(rendered()).toContain(t('signedOutHint', { name: '商汤小浣熊' }))
  })

  it('keeps the document whose read started last, even when it settles first', async () => {
    // Request 0 hangs; the user's Refresh starts request 1, which the stub
    // answers in process.
    plan = (_url, _init, index) => index === 0 ? { hang: true } : statusReply
    statusReply = { ok: true, body: signedInStatus({ nickname: 'newer' }) }
    await mount()
    await press(en.refresh)
    expect(rendered()).toContain('newer')

    // The slow first read now settles with the older document. "Last to
    // settle wins" would revert the card to it.
    await release(0, { ok: true, body: signedInStatus({ nickname: 'older' }) })

    expect(rendered()).toContain('newer')
    expect(rendered()).not.toContain('older')
    expect(rendered()).not.toContain(NOTICE)
  })

  it('drops a superseded failure silently instead of blanking the card', async () => {
    plan = (_url, _init, index) => index === 0 ? { hang: true } : statusReply
    statusReply = { ok: true, body: signedInStatus({ nickname: 'newer' }) }
    await mount()
    await press(en.refresh)
    expect(rendered()).toContain('newer')

    // The superseded read fails. It has no claim on the card: no error state,
    // no notice, no label change.
    await release(0, { ok: false, status: 500, body: {} })

    expect(rendered()).toContain('newer')
    expect(rendered()).not.toContain(NOTICE)
    expect(rendered()).not.toContain(en.requestFailed)
  })

  it('keeps the account on screen when the refresh write is rejected', async () => {
    // The write path applies the same policy as a failed read: the reason is
    // attached beside the document, never in place of it.
    statusReply = { ok: true, body: signedInStatus({ nickname: 'nick', points: { total: 15 } }) }
    await mount()
    expect(rendered()).toContain('nick')

    writeReply = { ok: false, status: 500, body: {} }
    await press(en.refreshModels)

    const failed = rendered()
    expect(failed).toContain(NOTICE)
    expect(failed).toContain('HTTP 500')
    expect(failed).toContain('nick')
    expect(failed).not.toContain(en.requestFailed)
  })

  it('does not leave whitespace after the English no-nickname label', async () => {
    statusReply = { ok: true, body: signedInStatus() }
    const body = statusReply.body as Record<string, unknown>
    delete body['nickname']
    await mount()
    const text = rendered()
    expect(text).toContain('Signed in as')
    expect(text).not.toContain('Signed in as ')
  })

  it('names the product from the variant descriptor in title, intro, and status route', async () => {
    // The card is variant-driven: displayName feeds `{name}` copy and the
    // status route comes from the descriptor the registration injected.
    await mount()
    expect(rendered()).toContain(t('title', { name: '商汤小浣熊' }))
    expect(rendered()).toContain(t('intro', { name: '商汤小浣熊' }))
    expect(calls[0]!.url).toBe(RACCOON_STATUS_PATH)
  })
})
