/**
 * Node-free constants and types shared by the host and browser halves.
 *
 * The host bundle and the browser bundle are built separately, so every route
 * the card may ask for is a literal here rather than a computed suffix: a
 * shared expression is one build-config drift away from the desk calling a
 * route the host never mounted.
 *
 * @module dsh-raccoon-connect/status-paths
 */

/** Plugin-owned read-only status endpoint consumed by the settings card. */
export const RACCOON_STATUS_PATH = '/plugins/dsh-raccoon-connect/status'

/**
 * Plugin-owned probe control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard defends against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore
 * also requires the in-process key the browser half receives with the status
 * document.
 */
export const RACCOON_PROBE_PATH = '/plugins/dsh-raccoon-connect/probe'

/** One model's recorded probe observation, as the card displays it. */
export interface RaccoonWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown'
  efforts: readonly string[]
  probedAt: number
}

/** Probe section of the status document. */
export interface RaccoonWebProbeSection {
  /** Whether the user has authorized spending credit on probes. */
  consent: boolean
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[]
  /** Recorded observations. */
  results: readonly RaccoonWebProbeModel[]
}

/** Action requested from the probe control route. */
export interface RaccoonProbeAction {
  /**
   * `probe` spends credit on one model; `clear` drops recorded observations;
   * `refresh` re-reads the credential and re-fetches the model catalog.
   *
   * All three are writes, which is why they share this route's in-process key
   * and loopback guards rather than the read-only status GET.
   */
  action: 'probe' | 'clear' | 'refresh'
  /** Target model id; required for `probe`. */
  model?: string
}

/**
 * Where the models the card is showing came from.
 *
 * A stale list must be tellable apart from "offline with a saved list", or the
 * user cannot judge whether the models on screen still match the upstream.
 */
export interface RaccoonWebCatalog {
  /**
   * Degradation order: `live` (fetched now) → `saved` (this account's last
   * successful fetch, restored after a restart or a failed fetch) → `fallback`
   * (the roster compiled into the plugin).
   */
  source: 'live' | 'saved' | 'fallback'
  /** When the live catalog last succeeded, epoch ms. */
  fetchedAt?: number
  /** Why the most recent fetch failed, when it did, redacted for display. */
  error?: string
}

/** Billing facts for one served model, rendered as name suffix and card badges. */
export interface RaccoonWebModelBadge {
  id: string
  name: string
  /** Whether the model is currently free (`x0.00`). */
  free?: boolean
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[]
  /** Billing multiplier in display form, e.g. `x0.79`. */
  credits?: string
  /**
   * The rate cannot be stated right now and the card must say so — set when the
   * only price the upstream gave us came from a promotion that has since ended.
   */
  rateUnknown?: true
  /** Context capacity in tokens, taken verbatim from the upstream catalog. */
  contextWindow?: number
  /** Upstream's stated output ceiling for the model, when it declares one. */
  maxTokens?: number
  /** Whether the catalog tags this model as able to read images. */
  vision?: boolean
}

/** Account-level facts the card shows next to the token expiry. */
export interface RaccoonWebPoints {
  /** Remaining credit total, when the upstream exposes one. */
  total?: number
  /** Plan/package label as the upstream words it. */
  plan?: string
  /** Anything else the billing endpoint said worth showing, verbatim. */
  note?: string
}

/** The JSON document the plugin card renders. */
export type RaccoonWebStatus =
  | {
    status: 'signed-out'
    /**
     * Why no credential is usable, when that is diagnosable rather than simply
     * "nobody signed in" — e.g. the refresh token was already rotated elsewhere
     * and the desktop app has to be opened once.
     */
    reason?: string
  }
  | {
    status: 'signed-in'
    /** Nickname from the access token's `name` claim. */
    nickname?: string
    /** `personal`, or the organization identity the token carries. */
    identity?: string
    /** Organization name, for team accounts. */
    orgName?: string
    /** Which file the credential in use came from. */
    source?: 'desktop' | 'dsh'
    /** Access-token expiry, epoch ms. */
    expiresAt?: number
    /** Refresh-token expiry, epoch ms. */
    refreshExpiresAt?: number
    catalog?: RaccoonWebCatalog
    models?: readonly RaccoonWebModelBadge[]
    points?: RaccoonWebPoints
    /** Why the points lookup failed, when it did. */
    pointsError?: string
    probe?: RaccoonWebProbeSection
    /**
     * In-process key authorizing probe control writes. Handed to the card with
     * the status document (the card is same-origin and already had to pass the
     * loopback guard); it is never persisted and rotates per process.
     */
    probeKey?: string
  }
  | { status: 'error'; message: string }
