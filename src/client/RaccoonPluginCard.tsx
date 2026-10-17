/**
 * 小浣熊 account status card contributed to DSH Plugin configuration.
 *
 * Renders every field the shared status document (`src/status-paths.ts`)
 * carries: sign-in state, identity, which credential file the session came
 * from, token expiries, catalog provenance, per-model context/rate/badges,
 * remaining credit, and the reasoning-effort probe section. The card is built
 * off a {@link RaccoonCardVariant} descriptor — id, display name, and the two
 * routes — so registering a second 小浣熊 product is a data change in
 * {@link CARD_VARIANTS}, not a component fork: the copy takes the product name
 * as a `{name}` parameter and the routes come from the descriptor.
 *
 * Three invariants this component exists to keep (each pinned by
 * `tests/plugin-card.spec.ts`):
 * - a failed read annotates the document already on screen, never blanks it;
 * - newest-read-wins: when reads overlap, only the one whose request started
 *   last may write state (a slow older response must not revert the card);
 * - the poll's liveness depends on the last *successful* read, so one
 *   transient error cannot disarm it, while a genuine signed-out answer stops it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { RACCOON_PROBE_PATH, RACCOON_STATUS_PATH } from '../status-paths.ts'
import type {
  RaccoonProbeAction,
  RaccoonWebCatalog,
  RaccoonWebModelBadge,
  RaccoonWebProbeSection,
  RaccoonWebStatus,
} from '../status-paths.ts'
import { isRaccoonWebStatus } from './status-document.ts'
import type { RaccoonSettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface RaccoonPluginCardInjected {
  t: (key: RaccoonSettingsKey, params?: Record<string, unknown>) => string
  /**
   * Which product variant this card instance renders.
   *
   * All variants share this component; the descriptor selects the status and
   * probe routes and names the product in the `{name}` copy parameters. It
   * defaults to {@link RACCOON_CARD} so a card rendered without the injection
   * (tests, tooling) keeps working against the primary product's routes.
   */
  variant?: RaccoonCardVariant
}

/**
 * The browser-visible half of a variant: identity and routes only.
 *
 * The host's full descriptor (`src/variants.ts`) also names files and env
 * vars; bundling that into the browser half would put filesystem knowledge in
 * a page and re-fork the single source the two halves already share through
 * `status-paths.ts`.
 */
export interface RaccoonCardVariant {
  /** Provider id registered with DSH; also the slot key, e.g. `raccoon`. */
  id: string
  /** Product name as users know it, substituted into `{name}` copy. */
  displayName: string
  statusPath: string
  probePath: string
}

/** 办公小浣熊 desktop, the plugin's only product today and its default card. */
export const RACCOON_CARD: RaccoonCardVariant = {
  id: 'raccoon',
  displayName: '商汤小浣熊',
  statusPath: RACCOON_STATUS_PATH,
  probePath: RACCOON_PROBE_PATH,
}

/** Every card, in display order. A second variant joins this list, nothing else changes. */
export const CARD_VARIANTS: readonly RaccoonCardVariant[] = [RACCOON_CARD]

/**
 * Props delivered by the Plugin configuration item slot.
 *
 * DSH >= 0.2.0 no longer exports `settings.plugins.tab` in the render slot
 * union, so the runtime props are widened to `Record<string, unknown>` rather
 * than keyed off the removed literal. The card only reads the `inject`-ed
 * fields, which the caller supplies (see `client/index.tsx`).
 */
export type RaccoonPluginCardProps =
  Record<string, unknown>
  & Partial<RaccoonPluginCardInjected>

const POLL_INTERVAL_MS = 60_000

const cardStyle: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
}
const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  border: 0,
  padding: '13px 14px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}
const headTextStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 3 }
const nameStyle: CSSProperties = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
const descriptionStyle: CSSProperties = { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const chevronStyle: CSSProperties = { flex: '0 0 auto', fontSize: 18, lineHeight: 1, transition: 'transform 120ms ease' }
const cardBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 14px 18px' }

const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const quotaListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 2 }
const quotaGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const quotaTitleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const quotaLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const modelBadgeStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const modelOfferStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const modelRateStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const modelBadgeChipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}

/**
 * Localize an upstream promotional badge label, with an unknown-badge fallback.
 *
 * The 小浣熊 catalog spells badges in Chinese (`限时免费`, `夜间折扣`). The two
 * known promotions are mapped so they follow the UI language, and anything
 * else passes through verbatim — an unrecognized badge is still information
 * the upstream chose to show, and translating it wrongly is worse than not
 * translating it.
 */
function modelBadgeLabel(badge: string, t: RaccoonPluginCardInjected['t']): string {
  if (badge === '限时免费') return t('badgeLimitedFree')
  if (badge === '夜间折扣') return t('badgeNightDiscount')
  if (badge === 'Free now') return t('badgeFreeNow')
  return badge
}

/**
 * Inline confirmation box for a paid detection. A modal alert for a one-line
 * decision is heavier than the action it guards, and `window.confirm` is not
 * available inside the DSH page anyway.
 */
const confirmBoxStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
}
const confirmRowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8 }

/** One probeable model's row: name on the left, state and action on the right. */
const probeRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
const probeRowEndStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }

/**
 * Tab strip for the card body. Kept visually light — a full pill would compete
 * with the section headings, and the card is already the densest surface the
 * plugin owns.
 */
const tabBarStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  marginTop: 4,
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}
const tabStyle: CSSProperties = {
  padding: '6px 12px',
  border: 0,
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  cursor: 'pointer',
}
const tabActiveStyle: CSSProperties = {
  borderBottom: '2px solid var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 600,
}
const tabPanelStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 16 }

/**
 * Primary action of the inline confirmation. Fill and text colour come from the
 * theme as a pair: `brand-primary` is a light accent here, so pairing it with a
 * hardcoded white would render white-on-white.
 */
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  minHeight: 0,
  padding: '4px 12px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-button-primary-fill)',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
}

/**
 * Status dot colour. Takes `'loading'` as well as the document's own states:
 * before the first response the card knows nothing about the account, so it
 * must not borrow the signed-out grey — that would read as "nothing is wrong,
 * nobody is signed in" when the truth is "not read yet".
 */
function dotStyle(status: 'loading' | RaccoonWebStatus['status']): CSSProperties {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', background: color }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value)
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
}

/**
 * Compact token count for display: the catalog's own round numbers (`200000`,
 * `1000000`) read better as `200K` / `1M`, and no precision is lost because
 * these values are always whole thousands.
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`
  return String(tokens)
}

/** The locale key naming one catalog source. */
function catalogSourceKey(source: RaccoonWebCatalog['source']): RaccoonSettingsKey {
  return source === 'live' ? 'catalogSourceLive' : source === 'saved' ? 'catalogSourceSaved' : 'catalogSourceFallback'
}

/**
 * One model offer row: name, promotional badges, and the billing rate.
 *
 * The rate sits under the name rather than beside it because the row already
 * spends its horizontal budget on badges; stacking keeps long model names and
 * several badges from squeezing the rate into an ellipsis.
 */
function ModelOfferRow({ model, t }: {
  model: RaccoonWebModelBadge
  t: RaccoonPluginCardInjected['t']
}): React.ReactNode {
  return (
    <div style={modelOfferStyle}>
      <div style={quotaLabelStyle}>
        <span>{model.name}</span>
        <span style={modelBadgeStyle}>
          {model.badges?.map(badge => (
            <span key={badge} style={modelBadgeChipStyle}>{modelBadgeLabel(badge, t)}</span>
          ))}
          {model.free === true ? <span style={modelBadgeChipStyle}>{t('freeModel')}</span> : null}
        </span>
      </div>
      {model.credits === undefined
        // No rate to show. When the host withheld it because the only price the
        // upstream gave came from an ended promotion, say so plainly rather
        // than showing nothing — silence here reads as "free", which is exactly
        // the claim being avoided.
        ? model.rateUnknown === true ? <span style={modelRateStyle}>{t('rateUnknown')}</span> : null
        : <span style={modelRateStyle}>{t('rate', { rate: model.credits })}</span>}
    </div>
  )
}

/**
 * Per-model context capacity, output ceiling, and image-reading capability.
 *
 * Purely a report of the upstream's own numbers: rows with none of the three
 * fields are omitted (the catalog declared nothing to say), largest window
 * first, and `vision === undefined` renders no chip at all — "the catalog does
 * not tag this model" is not the same claim as "this model cannot read images".
 */
function ContextTable({ models, t }: {
  models: readonly RaccoonWebModelBadge[] | undefined
  t: RaccoonPluginCardInjected['t']
}): React.ReactNode {
  const known = (models ?? [])
    .filter(model => model.contextWindow !== undefined || model.maxTokens !== undefined || model.vision !== undefined)
    .sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))
  if (known.length === 0) return null
  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t('contextHeading')}</h3>
      {known.map(model => (
        <div key={model.id} style={quotaLabelStyle}>
          <span>{model.name}</span>
          <span style={modelOfferStyle}>
            {model.contextWindow === undefined
              ? null
              : <span style={{ textAlign: 'right' }}>{t('contextWindow', { size: formatTokens(model.contextWindow) })}</span>}
            {model.maxTokens === undefined
              ? null
              : <span style={modelRateStyle}>{t('contextMaxOutput', { size: formatTokens(model.maxTokens) })}</span>}
            {model.vision === undefined
              ? null
              : <span style={modelRateStyle}>{t(model.vision ? 'visionYes' : 'visionNo')}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Reasoning-effort detection section: consent state, per-model detection, and
 * the recorded observations.
 *
 * Two deliberate UX rules:
 * - the confirmation is shown *before* any request, and its copy states the
 *   credit caveat; the document's `consent` flag is reported as a line so the
 *   user can see whether sweeps were authorized, never silently;
 * - a `non-validating` result is presented as an observation about the
 *   parameter ("this model does not check it"), never as a statement that a
 *   level is unsupported.
 */
function ProbeSection({ probe, t, onDetect, onClear, busy }: {
  probe: RaccoonWebProbeSection
  t: RaccoonPluginCardInjected['t']
  onDetect: (modelId: string) => void
  onClear: () => void
  busy: boolean
}): React.ReactNode {
  // Which model is awaiting confirmation. Confirmation is inline for the same
  // reason the Composer entry uses a bubble: a modal alert for a one-line
  // decision is heavier than the action it guards.
  const [pending, setPending] = useState<string>()
  // Which model this card last asked to detect. `busy` alone cannot answer
  // that — it is true for any in-flight request — so the running label needs
  // the id, otherwise every candidate button claims to be running at once.
  const [runningModel, setRunningModel] = useState<string>()
  // A sweep that finishes (or a catalogue change that removes the candidate)
  // must not leave a stale confirmation behind.
  useEffect(() => {
    if (pending !== undefined && !probe.candidates.includes(pending)) setPending(undefined)
  }, [pending, probe.candidates])
  // Clear the running label once the request settles.
  //
  // Keyed on `busy` alone this would fire immediately: the click that starts a
  // detection sets `runningModel` and `busy` in one batch, and an effect that
  // only checks `!busy` can still observe the pre-update value. So the label is
  // armed on the way up and released only after the run has actually been seen
  // in flight.
  const runningArmed = useRef(false)
  useEffect(() => {
    if (runningModel === undefined) return
    if (busy || probe.running) {
      runningArmed.current = true
      return
    }
    if (!runningArmed.current) return
    runningArmed.current = false
    setRunningModel(undefined)
  }, [runningModel, busy, probe.running])
  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t('probeHeading')}</h3>
      <p style={bodyStyle}>{t('probeIntro')}</p>
      <p style={bodyStyle}>{t('probeConsentHint')}</p>
      <p style={bodyStyle}>{t(probe.consent ? 'probeConsentOn' : 'probeConsentOff')}</p>
      {probe.running ? <p style={bodyStyle}>{t('probeRunningGeneric')}</p> : null}
      {/*
        * One row per probeable model, each carrying its own state and button.
        *
        * The buttons live in the same row as the model and its recorded result:
        * re-running a detected model must not mean clearing every other result,
        * and the order is fixed by the catalog, so nothing moves when a
        * detection lands.
        */}
      {probe.candidates.length === 0
        ? <p style={bodyStyle}>{t('probeResultEmpty')}</p>
        : (
          <div style={quotaGroupStyle}>
            {probe.candidates.map(id => {
              const result = probe.results.find(entry => entry.id === id)
              const name = result?.name ?? id
              return (
                <div key={id} style={modelOfferStyle}>
                  <div style={probeRowStyle}>
                    <span>{name}</span>
                    <span style={probeRowEndStyle}>
                      {result === undefined ? null : (
                        <span style={modelBadgeChipStyle}>
                          {result.validation === 'validating'
                            ? result.efforts.length > 0 ? result.efforts.join(' / ') : t('probeResultNoLevels')
                            : t(result.validation === 'non-validating' ? 'probeResultNotValidating' : 'probeResultUnknown')}
                        </span>
                      )}
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={probe.running || busy}
                        onClick={() => { setPending(id) }}
                      >
                        {/*
                          * Only the button that was actually pressed reports
                          * progress; the card-wide `busy` flag is true for any
                          * in-flight request, so it cannot pick the label.
                          */}
                        {runningModel === id
                          ? t('probeRunning', { model: id })
                          : t(result === undefined ? 'probeStart' : 'probeRedetect')}
                      </button>
                    </span>
                  </div>
                  {result === undefined ? null
                    : <span style={modelRateStyle}>{t('probeResultAt', { time: formatTime(result.probedAt) })}</span>}
                  {/*
                    * The confirmation expands inside the row it belongs to:
                    * rendered after the whole list it would sit a screen away
                    * from the button that asked the question.
                    */}
                  {pending === id ? (
                    <div style={confirmBoxStyle}>
                      <p style={bodyStyle}>{t('probeConfirmBody', { model: name })}</p>
                      <div style={confirmRowStyle}>
                        <button type="button" style={buttonStyle} onClick={() => { setPending(undefined) }}>
                          {t('cancel')}
                        </button>
                        <button
                          type="button"
                          style={primaryButtonStyle}
                          disabled={probe.running || busy}
                          onClick={() => {
                            setRunningModel(id)
                            setPending(undefined)
                            onDetect(id)
                          }}
                        >
                          {t('probeConfirmAction')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}

      {probe.results.length === 0 ? null : (
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => { onClear() }}>
          {t('probeClear')}
        </button>
      )}
    </div>
  )
}

/** Render 小浣熊 sign-in state, catalog provenance, and credit as one expandable card. */
export function RaccoonPluginCard({ t, variant = RACCOON_CARD }: RaccoonPluginCardProps) {
  if (t === undefined) throw new Error('Raccoon plugin card requires its translation function')
  const [open, setOpen] = useState(false)
  /**
   * The document to render. `undefined` means *not read yet*, which is a
   * distinct state from "signed out": seeding this with a signed-out document
   * told an already-signed-in user they were signed out for the whole first
   * round trip (and forever, if the read never settled).
   */
  const [status, setStatus] = useState<RaccoonWebStatus>()
  /**
   * Whether the last **successful** read found a usable credential.
   *
   * Kept apart from `status` because the poll's liveness must depend on what the
   * account actually is, not on what the card last displayed: a failed read
   * leaves this untouched, so a transient failure cannot disarm the interval,
   * while a genuine signed-out answer still stops it.
   *
   * `undefined` therefore means "no successful read yet", which is also the
   * condition that decides whether a failed read has anything to preserve.
   */
  const [signedIn, setSignedIn] = useState<boolean>()
  /**
   * Why the most recent read failed, when it did. Rendered as a notice beside
   * whatever document is still on screen, rather than replacing it.
   */
  const [readFailure, setReadFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  // Three tabs. Default is the live status plus the actions the card carries;
  // the two reference sets — context capacity, then rates and credit — are
  // deliberate visits, since neither changes while you watch.
  const [tab, setTab] = useState<'status' | 'context' | 'details'>('status')
  const mounted = useRef(true)
  /**
   * Identity of the newest read that may write. Assigned when a read *starts*,
   * so a response is superseded by anything begun after it — "the response whose
   * request started last wins". Without this, a slow poll begun before a manual
   * action could settle after the action's own refresh and restore the older
   * document.
   */
  const readSeq = useRef(0)
  /** Manual requests in flight, so unmount can abort them like the poll's. */
  const manualControllers = useRef(new Set<AbortController>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of manualControllers.current) controller.abort()
      manualControllers.current.clear()
    }
  }, [])

  /** Register a manual request's controller so unmount aborts it. */
  const trackController = useCallback((): AbortController => {
    const controller = new AbortController()
    manualControllers.current.add(controller)
    return controller
  }, [])

  /**
   * Read the status document and apply it under the two policies the card's
   * correctness rests on:
   *
   * - a non-document body (empty, `null`, a non-JSON page) is a failed read, not
   *   something to store and then dereference in the render;
   * - a failed read never discards a document already on screen. It is recorded
   *   and shown as a notice beside that document; only when nothing has been
   *   read yet does the failure itself become the rendered state.
   *
   * Returns whether this read produced the current document.
   */
  const refresh = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    const seq = ++readSeq.current
    // Superseded (a newer read started) or unmounted: write nothing, report
    // nothing. A dropped response must not surface as a failure of its own.
    const current = (): boolean => mounted.current && signal?.aborted !== true && seq === readSeq.current
    try {
      const response = await fetch(variant.statusPath, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!isRaccoonWebStatus(value)) throw new Error(t('statusResponseInvalid'))
      if (!current()) return false
      setStatus(value)
      // Only a document that states the session may move the poll gate. An
      // `error` document (which only a failed read produces, and which the host
      // never sends) says nothing about the account, so it must not stop the
      // interval — that would strand the card on a state it cannot leave.
      if (value.status === 'signed-in') setSignedIn(true)
      else if (value.status === 'signed-out') setSignedIn(false)
      setReadFailure(undefined)
      return true
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('requestFailed')
      if (current()) {
        setReadFailure(message)
        // Nothing on screen to preserve: the failure is all there is to show.
        setStatus(previous => previous === undefined ? { status: 'error', message } : previous)
      }
      return false
    }
  }, [t, variant.statusPath])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [open, refresh])

  useEffect(() => {
    // Gated on the last successful read, never on the rendered document: a
    // failed read must not be able to disarm this effect, or one transient
    // error would leave the card blank until the user clicked Refresh.
    if (!open || signedIn === false) return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, refresh, signedIn])

  const manualRefresh = async (): Promise<void> => {
    setBusy(true)
    const controller = trackController()
    try {
      await refresh(controller.signal)
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setBusy(false)
    }
  }

  /**
   * Ask the host to re-read the credential and re-fetch this variant's catalog.
   *
   * Shares the probe route's key and guards: it is a write that spends an
   * upstream request, so it does not belong on the read-only status GET. A
   * failure is surfaced through the refreshed document's `catalog.error` rather
   * than thrown away, so the reason survives the round trip.
   */
  const refreshModels = useCallback(async (): Promise<void> => {
    const key = status?.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) return
    setBusy(true)
    const controller = trackController()
    try {
      const response = await fetch(variant.probePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Raccoon-Probe-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ action: 'refresh' } satisfies RaccoonProbeAction),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        // A rejected write is reported beside the document, exactly like a
        // failed read: replacing it would take the account, credit and model
        // list away over one failed action. Aborts stay silent.
        setReadFailure(error instanceof Error ? error.message : t('requestFailed'))
      }
      // The failed write has no follow-up read, so it unregisters here.
      manualControllers.current.delete(controller)
      return
    } finally {
      if (mounted.current) setBusy(false)
    }
    // Started after the write resolves, so this read outranks any poll that
    // began earlier and the refreshed list is what stays on screen.
    try {
      await refresh(controller.signal)
    } finally {
      // Unregistered only after this read settles: while it is in flight it is
      // still a manual request, so unmount must abort it exactly as it aborts
      // the write above and `manualRefresh`/`control` abort theirs.
      manualControllers.current.delete(controller)
    }
  }, [refresh, status, t, trackController, variant.probePath])

  /**
   * Run one control action and refresh the card's state afterwards.
   *
   * The key travels in a header, not the body: it authorizes the write, and
   * the host never accepts a prompt, a sentinel, or a model outside its own
   * catalog from here. `probe` and `clear` only — `refresh` is the dedicated
   * {@link refreshModels} path above.
   */
  const control = useCallback(async (action: {
    action: Exclude<RaccoonProbeAction['action'], 'refresh'>
    model?: string
  }): Promise<void> => {
    const key = status?.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) return
    setBusy(true)
    const controller = trackController()
    try {
      const response = await fetch(variant.probePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Raccoon-Probe-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify(action satisfies RaccoonProbeAction),
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const message = typeof value === 'object' && value !== null && 'error' in value
          ? String((value as Record<string, unknown>)['error'])
          : `HTTP ${response.status}`
        throw new Error(message)
      }
      await refresh(controller.signal)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        // Same policy as a failed read and as `refreshModels`: the reason is
        // reported beside the document, never in place of it. A detection that
        // did not complete must not erase the account and credit figures the
        // user was reading. Aborts stay silent.
        setReadFailure(error instanceof Error ? error.message : t('requestFailed'))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setBusy(false)
    }
  }, [refresh, status, t, trackController, variant.probePath])

  /**
   * Start a detection. Confirmation happens inline in the section, so this is
   * only ever called after the user has already agreed to spend credit.
   */
  const confirmDetect = useCallback((modelId: string): void => {
    void control({ action: 'probe', model: modelId })
  }, [control])

  const title = t('title', { name: variant.displayName })
  /*
   * `undefined` is "not read yet" and gets its own copy. It is not signed-out:
   * claiming that would be false for a user who is in fact signed in.
   */
  const label = status === undefined
    ? t('loading')
    : status.status === 'signed-in'
      ? status.nickname === undefined ? t('signedInAs', { nickname: '' }).trimEnd().replace(/[:：]$/, '') : t('signedInAs', { nickname: status.nickname })
      : status.status === 'error'
        ? t('requestFailed')
        : t('signedOut')

  return (
    <li style={cardStyle}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>{title}</span>
          <span style={descriptionStyle}>{t('intro', { name: variant.displayName })}</span>
        </span>
        <span aria-hidden="true" style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {open
        ? <div style={cardBodyStyle}>
            <h3 style={quotaTitleStyle}>{t('accountHeading')}</h3>
            <div style={rowStyle}>
              {/* `aria-busy` while nothing has been read: the value is pending, not absent. */}
              <div style={statusStyle} role="status" aria-busy={status === undefined}>
                <span aria-hidden="true" style={dotStyle(status === undefined ? 'loading' : status.status)} />
                <span>{label}</span>
              </div>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void manualRefresh() }}>
                {busy ? t('refreshing') : t('refresh')}
              </button>
            </div>
            {/*
              * A failed read is reported beside the document still on screen,
              * never in place of it: blanking the card over one transient error
              * loses the account, credit and model list the user was reading.
              * Cleared by the next successful read. `signedIn === undefined`
              * means no read has ever succeeded, so there is nothing to
              * annotate — the error state below already states the failure on
              * its own.
            */}
            {readFailure === undefined || signedIn === undefined
              ? null
              : <p style={errorStyle}>{t('statusRefreshFailed', { message: readFailure })}</p>}
            {status?.status === 'signed-in'
              ? <>
                  {/*
                    * Three tabs, split by what the reader came for.
                    *
                    * 1. Status — the live account facts and the actions the card
                    *    carries: identity, credential provenance, token expiries,
                    *    the model-list provenance with its refresh, and reasoning
                    *    level detection.
                    * 2. Context — every model's capacity and output ceiling.
                    * 3. Details — the credit balance and the per-model rate list.
                    */}
                  <div role="tablist" style={tabBarStyle}>
                    {(['status', 'context', 'details'] as const).map(id => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={tab === id}
                        onClick={() => { setTab(id) }}
                        style={{ ...tabStyle, ...(tab === id ? tabActiveStyle : {}) }}
                      >
                        {t(id === 'status' ? 'tabStatus' : id === 'context' ? 'tabContext' : 'tabDetails')}
                      </button>
                    ))}
                  </div>

                  {tab === 'status' ? (
                    <div style={tabPanelStyle}>
                      {status.identity === undefined ? null
                        : <p style={bodyStyle}>{status.identity === 'personal'
                          ? t('identityPersonal')
                          : t('identityOrg', { identity: status.identity })}</p>}
                      {status.orgName === undefined ? null
                        : <p style={bodyStyle}>{t('orgName', { name: status.orgName })}</p>}
                      {status.source === undefined ? null
                        : <p style={bodyStyle}>{t('credentialSource', {
                          source: status.source === 'desktop'
                            ? t('sourceDesktop', { name: variant.displayName })
                            : t('sourceDsh'),
                        })}</p>}
                      {status.expiresAt === undefined ? null
                        : <p style={bodyStyle}>{t('accessTokenExpires', { time: formatTime(status.expiresAt) })}</p>}
                      {status.refreshExpiresAt === undefined ? null
                        : <p style={bodyStyle}>{t('refreshTokenExpires', { time: formatTime(status.refreshExpiresAt) })}</p>}
                      {/*
                        * Catalog provenance. Without it a stale list is
                        * indistinguishable from a fresh one, and a user cannot
                        * tell whether what they see still matches the upstream.
                        * The refresh action sits here because this is the line
                        * that says whether the list needs refreshing.
                        */}
                      {status.catalog === undefined
                        ? null
                        : <div style={rowStyle}>
                            <span style={bodyStyle}>
                              {t('catalogSourceLine', { source: t(catalogSourceKey(status.catalog.source)) })}
                              {status.catalog.fetchedAt === undefined
                                ? ''
                                : ` · ${t('catalogFetchedAt', { time: formatTime(status.catalog.fetchedAt) })}`}
                            </span>
                            <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void refreshModels() }}>
                              {busy ? t('refreshingModels') : t('refreshModels')}
                            </button>
                          </div>}
                      {status.catalog?.error === undefined
                        ? null
                        : <p style={errorStyle}>{t('catalogError', { message: status.catalog.error })}</p>}
                      {status.probe === undefined ? null : (
                        <ProbeSection
                          probe={status.probe}
                          t={t}
                          busy={busy}
                          onDetect={confirmDetect}
                          onClear={() => { void control({ action: 'clear' }) }}
                        />
                      )}
                    </div>
                  ) : tab === 'context' ? (
                    <div style={tabPanelStyle}>
                      <ContextTable models={status.models} t={t} />
                    </div>
                  ) : (
                    <div style={tabPanelStyle}>
                      {(status.points === undefined && status.pointsError === undefined) ? null : (
                        <div style={quotaListStyle}>
                          <h3 style={quotaTitleStyle}>{t('pointsHeading')}</h3>
                          {status.points?.total === undefined ? null
                            : <p style={bodyStyle}>{t('pointsTotal', { total: formatNumber(status.points.total) })}</p>}
                          {status.points?.plan === undefined ? null
                            : <p style={bodyStyle}>{t('pointsPlan', { plan: status.points.plan })}</p>}
                          {status.points?.note === undefined ? null
                            : <p style={bodyStyle}>{t('pointsNote', { note: status.points.note })}</p>}
                          {status.pointsError === undefined ? null
                            : <p style={errorStyle}>{t('pointsError', { message: status.pointsError })}</p>}
                        </div>
                      )}
                      {(() => {
                        // Only models with something to say about price: a row
                        // with no rate, no `rateUnknown`, no badge, and not
                        // free would render an empty line that reads as a bug.
                        const priced = (status.models ?? []).filter(model =>
                          model.free === true
                          || (model.badges?.length ?? 0) > 0
                          || model.credits !== undefined
                          || model.rateUnknown === true)
                        if (priced.length === 0) return null
                        return (
                          <div style={quotaListStyle}>
                            <h3 style={quotaTitleStyle}>{t('modelsHeading')}</h3>
                            {priced.map(model => <ModelOfferRow key={model.id} model={model} t={t} />)}
                          </div>
                        )
                      })()}
                    </div>
                  )}
                </>
              : null}
            {status?.status === 'signed-out'
              // A concrete explanation replaces the generic hint: telling a
              // user to "sign in" is wrong advice when a credential was found
              // and rejected — for 小浣熊 the actionable case is that the
              // single-use refresh token was rotated elsewhere and the desktop
              // app has to be opened once. The model sections stay hidden:
              // without a credential the roster on screen would be an empty
              // lie, and the hint is the only actionable content.
              ? <p style={status.reason === undefined ? bodyStyle : errorStyle}>
                  {status.reason ?? t('signedOutHint', { name: variant.displayName })}
                </p>
              : null}
            {status?.status === 'error' ? <p style={errorStyle}>{status.message}</p> : null}
          </div>
        : null}
    </li>
  )
}
