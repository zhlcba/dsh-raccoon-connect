import z from "@deepseek-ai/schemastery";
import { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/variants.d.ts
/**
 * The 小浣熊 product variants this plugin serves.
 *
 * Everything that can differ between two SenseTime desktop clients — gateway
 * base, credential location, file names, display identity, routes — is one
 * descriptor here, so no module carries its own `if (raccoon)` branch and
 * adding a second product (e.g. 代码小浣熊) is a data change rather than a
 * refactor. Today there is exactly one: 办公小浣熊 desktop.
 *
 * This module is host-side (it names files and env vars). The browser half
 * takes the same routes from the Node-free `status-paths.ts`, which stays the
 * single source shared by both halves.
 *
 * @module dsh-raccoon-connect/variants
 */
/** One 小浣熊 product variant. */
interface RaccoonVariant {
  /** Provider id registered with DSH, e.g. `raccoon`. */
  id: string;
  /** Model-group heading and card title, e.g. `商汤小浣熊`. */
  displayName: string;
  /** Desktop app name as users know it, for diagnostics and error copy. */
  appName: string;
  /** OpenAI-compatible LLM gateway, including its `/llm/v2` suffix. */
  llmBase: string;
  /** Site origin the auth and billing endpoints hang off. */
  siteOrigin: string;
  /** Env var that overrides the desktop credential file location outright. */
  env: string;
  /** Env var the desktop app itself uses to relocate its config directory. */
  configDirEnv: string;
  /** Config directory relative to the home dir when `configDirEnv` is unset. */
  configDirRel: string;
  /** Basename of the desktop app's own credential file in that directory. */
  desktopFilename: string;
  /** Basename of the plugin-owned credential copy under `$DSH_HOME`. */
  ownFilename: string;
  /** Basename of the plugin-owned probe-record file under `$DSH_HOME`. */
  probeFilename: string;
  /** Basename of the plugin-owned saved-catalog file under `$DSH_HOME`. */
  catalogFilename: string;
  /** Same-origin status route consumed by this variant's card. */
  statusPath: string;
  /** Same-origin probe-control route consumed by this variant's card. */
  probePath: string;
}
/**
 * 办公小浣熊 desktop.
 *
 * Its credential file is the one the app already maintains for its own local
 * agent (`box-agent`), which is what makes zero-configuration reuse possible:
 * the app writes it on sign-in and on every token refresh, and the plugin only
 * ever has to read — and, when it refreshes, write back in the same shape.
 */
declare const RACCOON_PRIMARY: RaccoonVariant;
/** Every variant the plugin registers. */
declare const ALL_VARIANTS: readonly RaccoonVariant[];
/** Look up a variant by provider id. */
declare function variantFor(id: string): RaccoonVariant | undefined;
//#endregion
//#region src/auth.d.ts
/** Refresh outcome as reported by the upstream. */
interface RaccoonRefreshOutcome {
  accessToken: string;
  /**
   * The rotated refresh token. 小浣熊 always rotates it together with the
   * access token; an absent value means the upstream did not send one and the
   * caller must keep the previous token rather than assume it stayed valid.
   */
  refreshToken?: string;
}
/** Normalized 小浣熊 credential, timestamps in epoch milliseconds. */
interface RaccoonCredential {
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry from its JWT `exp`; 0 when the token is unparsable. */
  expiresAtMs: number;
  /** Refresh-token expiry from its JWT `exp`, when available. */
  refreshExpiresAtMs?: number;
  /** Stable per-account key used to scope saved catalogs and probe records. */
  accountId: string;
  /** Nickname from the access token's `name` claim. */
  nickname?: string;
  /** `personal`, or the organization identity the app stored. */
  identity?: string;
  orgName?: string;
  orgRole?: string;
  /** Which storage the credential was read from. */
  source: 'desktop' | 'dsh';
}
/** Read-only sign-in summary for status and doctor output. */
interface RaccoonAuthStatus {
  state: 'signed-in' | 'signed-out';
  expiresAtMs?: number;
  refreshExpiresAtMs?: number;
  nickname?: string;
  identity?: string;
  orgName?: string;
  source?: 'desktop' | 'dsh';
  /**
   * Why no credential is usable, when that is diagnosable rather than simply
   * "nobody signed in" — an exhausted refresh token being the case that matters
   * most, because the fix is to open the desktop app once.
   */
  reason?: string;
}
/** Constructor options; only {@link refresh} is required. */
interface RaccoonStoreOptions {
  variant: RaccoonVariant;
  /** Explicit desktop credential path, overriding env and the default. */
  desktopPath?: string;
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string;
  /** Performs the upstream token refresh. */
  refresh: (refreshToken: string) => Promise<RaccoonRefreshOutcome>;
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number;
  /** Filesystem surface, injectable for tests. */
  fs?: Pick<typeof import('node:fs/promises'), 'readFile' | 'writeFile' | 'stat' | 'rm'>;
  /** Whether rotated tokens are written back to the desktop file; default true. */
  writeBackDesktop?: boolean;
}
/**
 * Decode the JWT claims the credential files carry.
 *
 * The desktop document stores no expiry field of its own, so lifetime and
 * identity come from the tokens themselves: `exp`, `name`, `sid`, `iss`.
 * Signature verification is not the plugin's job — it forwards the token and the
 * upstream decides. Malformed or non-JWT values yield an empty claim set, which
 * callers treat as "expiry unknown" rather than "expired".
 */
declare function decodeJwtClaims(token: string): Record<string, unknown>;
/**
 * Parse the desktop app's credential document.
 *
 * Accepts the app's own key set and the two aliases its reader accepts for the
 * access token (`token`, `auth_token`), so an older or alternate build's file
 * still works. Returns undefined when the document carries no access token.
 */
declare function parseDesktopAuth(text: string): RaccoonCredential | undefined;
/**
 * Credential store with demand-driven, write-back refresh.
 *
 * Refresh policy: re-read the desktop file on every resolution (the app does
 * not cache it either), use a live access token as-is, and only refresh inside
 * the margin. A failed refresh still returns a not-yet-expired token, so an
 * unreachable refresh endpoint cannot take down a working session.
 */
declare class RaccoonCredentialStore {
  private readonly variant;
  private readonly refresh;
  private readonly refreshMarginMs;
  private readonly ownPath;
  private readonly fs;
  private readonly writeBackDesktop;
  private desktopPathOverride;
  private inflight;
  /** Desktop document last read, so a write-back can keep its other fields. */
  private desktopDocument;
  /** Whether the pre-refresh backup of the desktop file has been taken. */
  private backedUp;
  constructor(options: RaccoonStoreOptions);
  private candidates;
  /** The desktop credential path in effect, for diagnostics. */
  desktopAuthPath(): string;
  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string;
  /** Repoint the desktop file; a settings change applies on the next read. */
  setDesktopPath(path: string | undefined): void;
  /** Read the freshest stored credential without refreshing anything. */
  current(): Promise<RaccoonCredential | undefined>;
  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh — which matters more
   * here than in a read-only design, because two concurrent refreshes would burn
   * one single-use refresh token and strand the other caller.
   */
  resolve(): Promise<RaccoonCredential>;
  /** Read-only sign-in summary; never refreshes and never throws. */
  status(): Promise<RaccoonAuthStatus>;
  /**
   * Remove the plugin-owned copy and the desktop backup it wrote.
   *
   * The desktop credential file itself is never deleted: it belongs to the app,
   * and removing it would sign the user out of 小浣熊 as a side effect of a
   * plugin cleanup.
   */
  logout(): Promise<void>;
  private backupPath;
  private needsRefresh;
  private refreshNow;
  private refreshOnce;
  private isConflict;
  /** Error text with the presented credential stripped out. */
  private redact;
  private saveOwn;
  /**
   * Write the rotated pair back where the app reads it.
   *
   * The rewrite keeps the document's other fields and the app's own key order,
   * and mirrors its atomic temp-file-plus-rename write with mode 0600, so the
   * app cannot observe a half-written file. The first overwrite in a process
   * also leaves a backup of the replaced document next to the plugin's copy:
   * if a write-back ever strands the app's session, that file is the rollback.
   */
  private saveDesktop;
  /** The app's key order first, anything the user's file had afterwards. */
  private orderedDesktop;
  private backupDesktop;
  private writeAtomically;
  private remove;
  private read;
  /**
   * Read the first desktop candidate that exists.
   *
   * Only an absent file falls through to the next candidate; a file that is
   * present but unparsable is authoritative, so a broken file is never silently
   * skipped in favour of a stale older one. The parsed document is kept so a
   * later write-back can preserve the fields this plugin does not own.
   */
  private readDesktop;
  private readOwn;
  /** Whether the desktop credential file exists as a regular file. */
  desktopFilePresent(): Promise<boolean>;
}
//#endregion
//#region src/catalog.d.ts
/**
 * The 小浣熊 model catalog: upstream parsing, built-in fallback, per-account
 * persistence, and the visible/hidden flag that decides whether the provider's
 * model group appears at all.
 *
 * The upstream documents the catalog as `data.categories[].models[]` with a
 * `chat` category, per-model `params.context_window` / `params.max_tokens`,
 * `tags` for capabilities, and a `billing_*` family for price and promotion.
 * Field shapes here come from reading the desktop app's own parser
 * (`docs/upstream-protocol.md` §4), not from guessing, and every row is
 * validated on the way in: an unusable row is dropped rather than served as a
 * model that would fail the moment it is selected.
 *
 * @module dsh-raccoon-connect/catalog
 */
/** How the upstream says a model is billed right now. */
type RaccoonBillingStatus = 'normal' | 'discount' | 'limited_free';
/** One promotion window on a model's price. */
interface RaccoonBillingDiscount {
  /** Promotion name, shown as the badge, e.g. `夜间折扣`. */
  name: string;
  /** Factor applied to the row's list price while the window is active (0 = free). */
  multiplier: number;
  /** `HH:mm` daily window bounds, in the upstream's own timezone. */
  dailyStart?: string;
  dailyEnd?: string;
  /** Absolute window bounds as date strings. */
  startAt?: string;
  endAt?: string;
  /** Whether the upstream says this window is live right now. */
  active: boolean;
}
/** One catalog row, normalized. */
interface RaccoonCatalogModel {
  /** Wire model id; what actually goes into the request. */
  id: string;
  /** Short label from the upstream, without price or badges. */
  label: string;
  /** Longer note the upstream sometimes attaches to a row. */
  description?: string;
  /** Longer description in the upstream's own display form, when separate. */
  displayDescription?: string;
  /** Whether the upstream lists the model at all. */
  visible: boolean;
  /** Capability tags, with `image` / `image-understanding` normalized to `vision`. */
  tags: readonly string[];
  /**
   * Our effective image-input verdict for this row, as resolved by
   * {@link resolveVision}. It is deliberately separate from the `vision` tag: the
   * tag is what the *upstream* claims, and measurement has shown it wrong in both
   * directions. Rows served by {@link RaccoonCatalog.current} always carry it; a
   * hand-built row without it falls back to the tag.
   */
  vision?: boolean;
  /** Upstream's stated strength ranking; 1 when unspecified. */
  abilityLevel: number;
  contextWindow?: number;
  maxTokens?: number;
  /** List-price multiplier, before any active promotion. */
  billingMultiplier?: number;
  /** The multiplier the upstream says applies right now. */
  billingEffectiveMultiplier?: number;
  billingStatus?: RaccoonBillingStatus;
  billingStatusNote?: string;
  billingDiscounts: readonly RaccoonBillingDiscount[];
}
/** A parsed catalog document. */
interface RaccoonCatalogDocument {
  defaultModelId?: string;
  models: readonly RaccoonCatalogModel[];
}
/** What a card or log says about where the models came from. */
type RaccoonCatalogSource = 'live' | 'saved' | 'fallback';
/**
 * Image-input capability established by experiment rather than by the tag.
 *
 * The catalog's `vision` tag is the only capability field the upstream publishes
 * — a raw row carries nothing else (`ability_level`, `params`, `billing_*` and
 * `tags` are the whole vocabulary) — and on 2026-09-18 measurement found it wrong
 * on two of the five visible rows, in *both* directions. So the tag is a prior,
 * not a fact.
 *
 * The measurement is self-verifying and cheap: a generated PNG of three vertical
 * stripes whose colors are drawn at random per run is sent with "name the colors
 * left to right". A model that cannot see either says so or guesses; guessing the
 * ordered triple correctly is a 1/120 shot, and the gateway that drops the image
 * says so in the reply ("我无法看到或处理图片") rather than erroring — which is
 * exactly why over-claiming is not caught by a status code here.
 *
 * Measured against `POST /chat/completions`, one decisive request per model:
 *
 * | model | `vision` tag | reads images |
 * | --- | --- | --- |
 * | `sn-sensenova-6-8-flash-lite` | yes | yes |
 * | `sn-kimi-k3` | yes | yes (two independent runs) |
 * | `sn-glm-5-3` | yes | **no** — image silently dropped |
 * | `sn-glm-5-3-flash` | no | **yes** |
 * | `sn-deepseek-v4-1-flash` | no | **yes** |
 *
 * Every visible row is listed on purpose: a stale tag should not be able to flip a
 * model's capability back after the upstream edits its catalog, which is what
 * would happen if only the disagreements were recorded.
 */
declare const MEASURED_VISION: Readonly<Record<string, boolean>>;
/** Per-model capability forced from the plugin configuration. */
interface RaccoonVisionOverrides {
  /** Ids the user says do read images, whatever the catalog tag claims. */
  readonly imageInput?: readonly string[];
  /** Ids the user says must stay text-only. */
  readonly textOnly?: readonly string[];
}
/**
 * The image-input verdict for one row.
 *
 * `textOnly` outranks `imageInput` when an id appears in both: refusing an image
 * costs the user one clearly-labelled rejection, while admitting one the gateway
 * then discards produces a model that claims it cannot see — a worse failure, and
 * one that arrives after the message is already durable. An id the upstream has
 * never heard of keeps whatever the tag says; silence is not evidence of ability.
 */
declare function resolveVision(model: RaccoonCatalogModel, overrides?: RaccoonVisionOverrides): boolean;
/**
 * Parse a `model_catalog` response body.
 *
 * Accepts both the `{code, data}` envelope and a bare document, because the
 * gateway has been observed to answer either way depending on the endpoint.
 * Rows the plugin cannot call correctly (no window, or the desktop app's own
 * internal agent routes) are dropped here rather than surfacing a model that
 * errors on first use. Returns undefined when nothing usable survives, so the
 * caller degrades to the saved or built-in catalog instead of publishing an
 * empty group.
 */
declare function parseModelCatalog(document: unknown): RaccoonCatalogDocument | undefined;
/**
 * The roster compiled into the plugin.
 *
 * Used only when the account has no saved catalog and the live one cannot be
 * fetched (offline, gateway change, expired session). It is the catalog a real
 * account actually received (`docs/upstream-protocol.md`), narrowed to what is
 * stable: the windows and output ceilings we observed, and the capability tags
 * the gateway itself put on each row. Prices are deliberately absent — an
 * unknown price renders as 价格未知, which is honest, while a guessed multiplier
 * is a number users would trust and act on. Only ids the gateway serves as chat
 * models appear here: the app's internal agent binding (`raccoon-chat-ml-5-5`)
 * is a routing default, not a selectable model, and listing it would offer a
 * row that errors on first use.
 */
declare const FALLBACK_CATALOG: readonly RaccoonCatalogModel[];
/** Saved catalog document as persisted per account, tokens never included. */
interface SavedRaccoonCatalog {
  version: 1;
  source: RaccoonCatalogSource;
  fetchedAtMs: number;
  defaultModelId?: string;
  models: readonly RaccoonCatalogModel[];
}
/**
 * Per-account saved catalogs, one file per variant under `$DSH_HOME`.
 *
 * Keyed by account so switching users in the desktop app cannot serve one
 * account's roster (with its prices and windows) to another. Writes are
 * temp-file-plus-rename and failures are swallowed: a catalog cache is an
 * optimization, never a reason for a request to fail.
 */
declare class RaccoonCatalogStore {
  private readonly path;
  private entries;
  private loaded;
  constructor(path?: string);
  /** Which account key is currently in use; scoping is explicit, not ambient. */
  private static keyFor;
  /**
   * Re-validate one row written by this store.
   *
   * Deliberately not {@link parseModelRow}: the file holds the *normalized*
   * shape (`id`/`label`/camelCase billing), and feeding that to the wire parser
   * would drop every row on the floor — `name` and `params` are simply not there
   * — which would silently collapse the documented live → saved → fallback
   * ladder into "always fallback after a restart".
   */
  private static reviveModel;
  private load;
  /** The last successful catalog for an account, if one is stored. */
  get(accountId: string): SavedRaccoonCatalog | undefined;
  /** Remember a catalog for an account. */
  set(accountId: string, catalog: SavedRaccoonCatalog): void;
  /** Forget an account (used when signing out). */
  remove(accountId: string): void;
  private persist;
}
/**
 * The live model list one provider route serves.
 *
 * Separate from the data it holds: visibility is a lifecycle decision (sign out
 * and the group disappears) while the rows are swapped independently, so the two
 * are not conflated in one field the caller has to remember to keep in step.
 */
declare class RaccoonCatalog {
  private readonly now;
  private readonly visionOverrides;
  private models;
  private defaultModelId;
  private shown;
  /**
   * @param now - clock used to re-derive time-boxed billing on every read.
   * @param visionOverrides - live view of the configured capability overrides.
   * Read per row, per call, so editing the configuration takes effect on the next
   * model-list render instead of only after the next catalog refresh.
   */
  constructor(now?: () => Date, visionOverrides?: () => RaccoonVisionOverrides);
  /** Replace the rows. An empty list still respects the visibility flag. */
  set(document: RaccoonCatalogDocument): void;
  /**
   * Current rows, with time-boxed billing re-derived and the image-input verdict
   * attached.
   *
   * The stored rows stay a faithful copy of what upstream said; `vision` is a
   * judgement made at read time from {@link MEASURED_VISION} plus the
   * configuration, so a plugin update that revises a verdict is never fighting a
   * verdict cached to disk.
   */
  current(): readonly RaccoonCatalogModel[];
  /** One row by wire id, billing re-derived, or undefined. */
  find(id: string): RaccoonCatalogModel | undefined;
  /** Hide the group without dropping its rows (used while signed out). */
  hide(): void;
  /** Show a group whose rows have been restored. */
  show(): void;
  /** Whether the group is currently visible to the pickers. */
  get visible(): boolean;
  /** The account's default model, when the catalog declared one. */
  get defaultModel(): string | undefined;
  /** Forget everything; used when the account changes. */
  clear(): void;
}
//#endregion
//#region src/status-paths.d.ts
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
declare const RACCOON_STATUS_PATH = "/plugins/dsh-raccoon-connect/status";
/**
 * Plugin-owned probe control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard defends against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore
 * also requires the in-process key the browser half receives with the status
 * document.
 */
declare const RACCOON_PROBE_PATH = "/plugins/dsh-raccoon-connect/probe";
/** One model's recorded probe observation, as the card displays it. */
interface RaccoonWebProbeModel {
  id: string;
  name: string;
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown';
  efforts: readonly string[];
  probedAt: number;
}
/** Probe section of the status document. */
interface RaccoonWebProbeSection {
  /** Whether the user has authorized spending credit on probes. */
  consent: boolean;
  /** Whether a sweep is in flight right now. */
  running: boolean;
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[];
  /** Recorded observations. */
  results: readonly RaccoonWebProbeModel[];
}
/**
 * Where the models the card is showing came from.
 *
 * A stale list must be tellable apart from "offline with a saved list", or the
 * user cannot judge whether the models on screen still match the upstream.
 */
interface RaccoonWebCatalog {
  /**
   * Degradation order: `live` (fetched now) → `saved` (this account's last
   * successful fetch, restored after a restart or a failed fetch) → `fallback`
   * (the roster compiled into the plugin).
   */
  source: 'live' | 'saved' | 'fallback';
  /** When the live catalog last succeeded, epoch ms. */
  fetchedAt?: number;
  /** Why the most recent fetch failed, when it did, redacted for display. */
  error?: string;
}
/** Billing facts for one served model, rendered as name suffix and card badges. */
interface RaccoonWebModelBadge {
  id: string;
  name: string;
  /** Whether the model is currently free (`x0.00`). */
  free?: boolean;
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[];
  /** Billing multiplier in display form, e.g. `x0.79`. */
  credits?: string;
  /**
   * The rate cannot be stated right now and the card must say so — set when the
   * only price the upstream gave us came from a promotion that has since ended.
   */
  rateUnknown?: true;
  /** Context capacity in tokens, taken verbatim from the upstream catalog. */
  contextWindow?: number;
  /** Upstream's stated output ceiling for the model, when it declares one. */
  maxTokens?: number;
  /** Whether the catalog tags this model as able to read images. */
  vision?: boolean;
}
/** Account-level facts the card shows next to the token expiry. */
interface RaccoonWebPoints {
  /** Remaining credit total, when the upstream exposes one. */
  total?: number;
  /** Plan/package label as the upstream words it. */
  plan?: string;
  /** Anything else the billing endpoint said worth showing, verbatim. */
  note?: string;
}
/** The JSON document the plugin card renders. */
type RaccoonWebStatus = {
  status: 'signed-out';
  /**
   * Why no credential is usable, when that is diagnosable rather than simply
   * "nobody signed in" — e.g. the refresh token was already rotated elsewhere
   * and the desktop app has to be opened once.
   */
  reason?: string;
} | {
  status: 'signed-in';
  /** Nickname from the access token's `name` claim. */
  nickname?: string;
  /** `personal`, or the organization identity the token carries. */
  identity?: string;
  /** Organization name, for team accounts. */
  orgName?: string;
  /** Which file the credential in use came from. */
  source?: 'desktop' | 'dsh';
  /** Access-token expiry, epoch ms. */
  expiresAt?: number;
  /** Refresh-token expiry, epoch ms. */
  refreshExpiresAt?: number;
  catalog?: RaccoonWebCatalog;
  models?: readonly RaccoonWebModelBadge[];
  points?: RaccoonWebPoints;
  /** Why the points lookup failed, when it did. */
  pointsError?: string;
  probe?: RaccoonWebProbeSection;
  /**
   * In-process key authorizing probe control writes. Handed to the card with
   * the status document (the card is same-origin and already had to pass the
   * loopback guard); it is never persisted and rotates per process.
   */
  probeKey?: string;
} | {
  status: 'error';
  message: string;
};
//#endregion
//#region src/client-identity.d.ts
/**
 * The desktop client's own identity, as the 小浣熊 gateway expects to see it.
 *
 * The web renderer derives `X-Client-Platform` / `X-Client-Version` /
 * `X-Client-Device-ID` from its user-agent string; a headless plugin has no
 * user agent, so it reads the same facts from where the app leaves them:
 * `desktop-device-identity.json` in the app's Electron user-data directory, and
 * the install tree for the version. Every field is optional — the gateway adds
 * these headers when it has them and omits them otherwise, and a machine where
 * the app has never run must still be able to use a credential file it was
 * pointed at explicitly.
 *
 * @module dsh-raccoon-connect/client-identity
 */
/** The headers this plugin sends, once resolved. */
interface RaccoonClientIdentity {
  platform: string;
  version?: string;
  deviceId?: string;
  /** Electron user-data directory the credential was found in, for doctor. */
  userDataDir?: string;
}
/** Candidate user-data directories per platform, in probe order. */
declare function userDataCandidates(): string[];
/**
 * Resolve the identity headers to send, reading disk at most once per process.
 *
 * Environment overrides win so a user on a non-standard install (portable app,
 * different profile, WSL) can pin the values without code changes:
 * `RACCOON_CLIENT_PLATFORM`, `RACCOON_CLIENT_VERSION`, `RACCOON_CLIENT_DEVICE_ID`.
 */
declare function resolveClientIdentity(): RaccoonClientIdentity;
//#endregion
//#region src/upstream.d.ts
/** What went wrong upstream, in the plugin's own vocabulary. */
type RaccoonErrorKind = 'session_dead' | 'hard_credit' | 'soft_rate' | 'not_found' | 'server' | 'client';
/**
 * Map an upstream failure onto a kind.
 *
 * Order matters: the gateway answers most failures with HTTP 400 plus a business
 * code, so the code and message have to be read before the status decides.
 */
declare function classifyUpstreamError(status: number, body: string): RaccoonErrorKind;
/** A failed upstream call, with the kind the shim should re-expose. */
interface RaccoonUpstreamFailure {
  ok: false;
  status: number;
  kind: RaccoonErrorKind;
  message: string;
}
/** A successful streaming call: the caller pipes the body through untouched. */
interface RaccoonUpstreamStream {
  ok: true;
  status: number;
  body: ReadableStream<Uint8Array>;
  contentType: string;
}
/** One reasoning-effort probe attempt's observable outcome. */
interface RaccoonProbeAttempt {
  status: number;
  /** Whether the upstream accepted the parameter value at all. */
  accepted: boolean;
  /** Whether any SSE data arrived, which is the only proof it was used. */
  streamed: boolean;
  /** Business code from a rejected body, for the non-validating test. */
  errorCode?: string;
  /** Rejection text, which is where `params_invalid_error` actually appears. */
  message?: string;
}
/** Options for the probe's single request. */
interface RaccoonProbeOptions {
  effort?: string;
  /** Whether the account is billed through an organization route. */
  systemPrefix?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}
/** Constructor options. */
interface RaccoonUpstreamOptions {
  variant: RaccoonVariant;
  /** Identity headers; resolved lazily so a late app install is still picked up. */
  identity?: () => RaccoonClientIdentity;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
  /** Non-streaming request timeout; streaming is never timed out this way. */
  timeoutMs?: number;
}
/** The 小浣熊 gateway client. */
declare class RaccoonUpstreamClient {
  private readonly variant;
  private readonly identity;
  private readonly fetchImpl;
  private readonly timeoutMs;
  constructor(options: RaccoonUpstreamOptions);
  /** LLM gateway base, without a trailing slash. */
  get llmBase(): string;
  private get authBase();
  private get pointsBase();
  /**
   * Headers every authenticated call carries.
   *
   * The identity headers are omitted rather than sent empty: the web client
   * only adds them when it could parse its own user agent, and an empty
   * `X-Client-Device-ID` is a different statement from no header.
   */
  private headers;
  /** POST with a timeout that never fires once streaming starts. */
  private request;
  private static textOf;
  /**
   * Unwrap the `{code, message, data}` envelope.
   *
   * A non-zero code is a failure even on HTTP 200, and the message is kept
   * because its business phrase is how `classifyUpstreamError` recognizes credit
   * exhaustion. A body with no envelope at all is returned as-is, since that is
   * how the gateway answers some endpoints.
   */
  private static envelope;
  private static failure;
  /**
   * Exchange a refresh token for a fresh pair.
   *
   * Deliberately unauthenticated: the refresh token is the credential, and the
   * gateway rejects a request that also carries an `Authorization` header.
   * The desktop app's failure text is reproduced here so a caller that sees the
   * error knows which leg broke.
   */
  refresh(refreshToken: string): Promise<RaccoonRefreshOutcome>;
  /** Fetch and parse the model catalog. */
  fetchCatalog(accessToken: string, signal?: AbortSignal): Promise<RaccoonCatalogDocument>;
  /** Remaining credit and plan label, best effort. */
  fetchBalance(accessToken: string, signal?: AbortSignal): Promise<RaccoonWebPoints>;
  /**
   * Stream one chat completion.
   *
   * The body is passed through as the caller built it: this gateway is the same
   * OpenAI-compatible endpoint the desktop app's own agent uses, so rewriting
   * fields here would only risk diverging from what it actually accepts. The
   * response body is returned unread so the shim can pipe it byte for byte.
   */
  chatStream(accessToken: string, body: unknown, signal?: AbortSignal): Promise<RaccoonUpstreamStream | RaccoonUpstreamFailure>;
  /**
   * Spend the smallest possible request to learn whether one parameter value is
   * honored.
   *
   * `max_tokens` is kept at the gateway's floor and the reader hangs up on the
   * first SSE event, because a probe that waits for a full answer is a paid
   * completion wearing a lab coat.
   */
  probeEffort(accessToken: string, model: string, options?: RaccoonProbeOptions): Promise<RaccoonProbeAttempt>;
}
//#endregion
//#region src/probe.d.ts
/** What a sweep concluded about the upstream's parameter handling. */
type RaccoonProbeValidation = 'validating' | 'non-validating' | 'unknown';
//#endregion
//#region src/probe-store.d.ts
/** One stored observation. */
interface RaccoonProbeRecord {
  fingerprint: string;
  validation: RaccoonProbeValidation;
  efforts: readonly string[];
  probedAtMs: number;
  pluginVersion: string;
  account: string;
}
/** What a fingerprint is computed from; keep this list short and deliberate. */
declare function probeFingerprint(model: RaccoonCatalogModel): string;
/**
 * File-backed store, one file per variant.
 *
 * The file holds `{version, records: {modelId: record}}`. A corrupt or
 * foreign-version file reads as empty rather than throwing: losing cached probe
 * answers is a smaller failure than refusing to start. Writes go through a temp
 * file and a rename, and a failure is swallowed for the same reason — the cache
 * is an optimization.
 */
declare class RaccoonProbeStore {
  private readonly path;
  private readonly now;
  private records;
  private loaded;
  constructor(path?: string, now?: () => number);
  private load;
  /** The live observation for one model, or undefined when none can be trusted. */
  get(account: string, model: string, fingerprint: string): RaccoonProbeRecord | undefined;
  /**
   * Record one sweep's outcome for a model.
   *
   * Returns whether it was stored, so a caller can tell the user "nothing was
   * learned" without implying the write failed.
   */
  set(model: string, record: RaccoonProbeRecord): boolean;
  /** Newest-first view for display. */
  list(account?: string): {
    model: string;
    record: RaccoonProbeRecord;
  }[];
  /** Drop every observation, e.g. when the account changes. */
  clear(): void;
  private persist;
}
//#endregion
//#region src/probe-service.d.ts
/** Why a probe request did not run. */
type RaccoonProbeRefusal = 'no-consent' | 'not-signed-in' | 'not-candidate';
/** Outcome of a probe request. */
type RaccoonProbeResult = {
  ok: true;
} | {
  ok: false;
  reason: RaccoonProbeRefusal;
};
/** Constructor dependencies. */
interface RaccoonProbeServiceOptions {
  catalog: RaccoonCatalog;
  store: RaccoonCredentialStore;
  upstream: RaccoonUpstreamClient;
  probeStore: RaccoonProbeStore;
  /** Standing authorization from settings. */
  consent: () => boolean;
  pluginVersion: string;
  /** Called after a record lands so the picker can pick up a new effort set. */
  notify: () => void;
  now?: () => number;
}
/** Orchestrates sweeps and holds their in-flight state. */
declare class RaccoonProbeService {
  private readonly options;
  /** Tail of the queue; every sweep is chained onto it. */
  private tail;
  /** The sweep currently running, if any. */
  private current;
  private runningCount;
  constructor(options: RaccoonProbeServiceOptions);
  /** Whether a sweep is in flight right now. */
  isRunning(): boolean;
  /**
   * Models the user could probe: every listed model without a decisive recorded
   * observation.
   *
   * The catalog's `reasoning` tag is tempting as a filter and is not one: it
   * labels the desktop app's routing presets, not the gateway's parameter
   * handling. Measured against the live catalog, `sn-glm-5-3-flash` carries no
   * `reasoning` tag and still streams `reasoning_content`, so narrowing by the
   * tag would hide a model the user may well want an effort control for. The
   * probe is the only evidence about `reasoning_effort` itself, so the only
   * exclusion here is "already answered".
   */
  candidates(): Promise<{
    id: string;
    label: string;
  }[]>;
  /** Recorded observations for the current account, newest first. */
  results(): Promise<RaccoonWebProbeModel[]>;
  /**
   * Probe one model, queued behind any sweep already running.
   *
   * `manual` is the button press. Automatic callers pass false and are refused
   * unless the user granted standing consent, which is what keeps a catalog
   * refresh or a status poll from silently spending credit.
   */
  probe(modelId: string, manual: boolean): Promise<RaccoonProbeResult>;
  /** Forget every recorded observation. */
  clear(): Promise<void>;
  /** Bind one model id to a send function that always uses a fresh token. */
  private makeSender;
}
//#endregion
//#region src/shim.d.ts
/** Hardening knobs, overridable only for tests. */
interface RaccoonShimOptions {
  /** Resolves an access token, refreshing if needed. May throw. */
  accessToken: () => Promise<string>;
  /** Upstream client used for the forwarded call. */
  upstream: Pick<RaccoonUpstreamClient, 'chatStream'>;
  /** Serves `/v1/models`; may be absent until the first catalog lands. */
  catalog?: () => RaccoonCatalog;
}
/** A started shim. */
interface RaccoonShim {
  /** Base URL pi-ai should be pointed at, without the `/v1` suffix. */
  baseUrl(): string;
  /** The per-process bearer secret the caller must present. */
  token(): string;
  /** Model list in OpenAI's `/v1/models` shape. */
  models(): {
    object: string;
    data: {
      id: string;
      object: string;
      owned_by?: string;
    }[];
  };
  stop(): Promise<void>;
  /** Port actually bound; diagnostics only. */
  port(): number;
}
/**
 * Start the shim.
 *
 * The server is created and bound here rather than lazily: `baseUrl()` is read
 * while the provider is being registered, and a port that only exists after the
 * first request cannot be advertised to pi-ai.
 */
declare function startRaccoonShim(options: RaccoonShimOptions): Promise<RaccoonShim>;
//#endregion
//#region src/adapter.d.ts
/**
 * Resolve one model's reasoning capability into pi-ai's `thinkingLevelMap`.
 *
 * The 小浣熊 catalog declares no effort vocabulary, so the only source is a
 * user-authorized local probe. Two rules keep an observation from being
 * over-read:
 *
 * - a `non-validating` observation yields **no** control at all: that upstream
 *   accepted a value that cannot exist, so every per-level answer it could give
 *   would be a false positive;
 * - `off` is never offered. Disabling thinking is a separate capability, and no
 *   amount of accepting other values proves it.
 *
 * The offered set means "the upstream did not reject this spelling", not "this
 * measurably changes what the model does".
 */
declare function reasoningFields(observed?: RaccoonProbeRecord): {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
};
/** Constructor dependencies. */
interface RaccoonAdapterOptions {
  providerId: string;
  displayName: string;
  shim: RaccoonShim;
  catalog: RaccoonCatalog;
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined;
  /** Look up a local probe observation for a model. */
  observe?: (modelId: string) => RaccoonProbeRecord | undefined;
}
/** What {@link createRaccoonAdapter} hands back. */
interface RaccoonAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
/**
 * Assemble the adapter.
 *
 * `getModels` is delegated to a live catalog read, so stream dispatch runs
 * through the constructed provider while the catalog answer tracks the upstream
 * refresh. `baseUrl` is re-resolved per read because the shim's port is
 * ephemeral and the provider is built once.
 */
declare function createRaccoonAdapter(options: RaccoonAdapterOptions): RaccoonAdapter;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name; matches the `id` this bundle's patch inserts. */
declare const name = "llm-raccoon";
/** The LLM registry must exist before a provider can register into it. */
declare const inject: string[];
/**
 * Settings namespace owning the card's section.
 *
 * The namespace is what makes the card *render*: the settings Plugins tab
 * dispatches `settings.plugin.item` by `entryKey = ns` for each served namespace
 * and skips a card whose key names no installed section. So one card needs one
 * section, and the section's schema must be split the same way as the card.
 */
declare const RACCOON_SETTINGS_NS: SettingsNamespace;
/** Resolve the sweep interval, honoring the override when it is usable. */
declare function credentialPollMs(): number;
/** Plugin configuration. */
interface Config {
  /**
   * Explicit path to the desktop app's credential file, overriding
   * `RACCOON_AUTH_FILE`, `BOX_AGENT_CONFIG_DIR`, and the default
   * `~/.box-agent/config/auth.json`.
   */
  authFile?: string;
  /**
   * Whether the user has standing authorization for reasoning-effort probes.
   * Off by default: each probe sends real requests that may spend credit.
   */
  probeConsent?: boolean;
  /**
   * Model ids to be offered image input regardless of what the catalog tag says.
   *
   * The upstream's `vision` tag is its only capability field and is demonstrably
   * wrong on some rows, so the plugin ships measurements for the models it could
   * verify (`MEASURED_VISION`). This list is the rest of the gap: a newly listed
   * model that reads images but is untagged can be enabled here without waiting
   * for a plugin release.
   */
  visionModelIds?: string[];
  /**
   * Model ids to keep text-only. Wins over {@link visionModelIds} when an id
   * appears in both, because a refusal is a cheaper mistake than an image the
   * gateway silently discards.
   */
  textOnlyModelIds?: string[];
}
declare const Config: z<Config>;
/**
 * The configuration as the catalog wants it.
 *
 * Ids are trimmed and blanks dropped: a hand-edited list with a stray empty entry
 * or trailing spaces should describe the models the user named, nothing more — an
 * empty id matching everything would be the one way this escape hatch could
 * silently switch capability off for the whole roster.
 */
declare function visionOverridesOf(config: Config): RaccoonVisionOverrides;
/**
 * Everything the running plugin holds about one provider route.
 *
 * The mutable lifecycle fields are typed `T | undefined` rather than left
 * optional: clearing them (a fetch that stopped being relevant, a shim handed
 * back on disposal, an error that a later success supersedes) is the normal
 * transition, and `exactOptionalPropertyTypes` only allows that assignment when
 * the type says undefined is a value the field can hold.
 */
interface Runtime {
  variant: typeof RACCOON_PRIMARY;
  store: RaccoonCredentialStore;
  client: RaccoonUpstreamClient;
  catalog: RaccoonCatalog;
  probeStore: RaccoonProbeStore;
  probeService: RaccoonProbeService;
  savedCatalogs: RaccoonCatalogStore;
  /** Where the currently served models came from. */
  source: RaccoonCatalogSource;
  fetchedAtMs?: number | undefined;
  error?: string | undefined;
  lastAttemptMs: number;
  /**
   * Bumped on every identity transition. An in-flight fetch records the
   * generation it started under and writes nothing if that moved on — checking
   * identity alone is not enough, because two fetches for the *same* account can
   * still finish out of order and the older one would win.
   */
  generation: number;
  inflight?: {
    identity: string;
    generation: number;
    promise: Promise<void>;
  } | undefined;
  account?: string | undefined;
  registered: boolean;
  invalidate?: (() => void) | undefined;
  shim?: RaccoonShim | undefined;
  points?: RaccoonWebPoints | undefined;
  pointsError?: string | undefined;
  pointsAtMs?: number | undefined;
}
/** Badge rows for the card, derived from the catalog as it stands right now. */
declare function badgeRows(catalog: RaccoonCatalog, now?: Date): RaccoonWebModelBadge[];
/**
 * Point the runtime at an account identity, invalidating what the previous one
 * left behind.
 *
 * One helper for all four transitions (sweep sign-in, sweep sign-out, manual
 * refresh, and a refresh that finds the user has signed out), because each of
 * them has to do the same six things and a path that forgets one leaks state
 * across accounts.
 */
declare function adoptIdentity(runtime: Runtime, account: string | undefined): void;
/**
 * Fetch this account's catalog.
 *
 * - **One request at a time**: a second caller joins the in-flight fetch.
 * - **Generation-checked write-back**: a superseded answer is dropped.
 * - **`resolve()`, not `current()`**: only `resolve()` performs the single-flight
 *   token renewal, so an expired token refreshes instead of failing the fetch.
 *   That is also where the plugin writes a rotated refresh token back to the
 *   desktop file, which is what keeps the app signed in.
 */
declare function fetchCatalog(runtime: Runtime, account: string): Promise<void>;
/**
 * One credential sweep: notice sign-in, sign-out, and account switches.
 *
 * Never refreshes anything itself (`current()`, not `resolve()`), so an idle
 * plugin makes no upstream calls; the fetch path does the renewing.
 */
declare function sweep(runtime: Runtime): Promise<void>;
/** Build the document the settings card renders. Never throws. */
declare function buildStatus(runtime: Runtime, probeKey: string, consent: boolean, now?: number): Promise<RaccoonWebStatus>;
/**
 * Plugin entry point.
 *
 * @param ctx - Cordis context owning this plugin's effects.
 * @param config - the applied configuration, live-replaced by the settings section.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { ALL_VARIANTS, Config, FALLBACK_CATALOG, MEASURED_VISION, RACCOON_PRIMARY, RACCOON_PROBE_PATH, RACCOON_SETTINGS_NS, RACCOON_STATUS_PATH, RaccoonCatalog, RaccoonCredentialStore, RaccoonUpstreamClient, type RaccoonWebStatus, Runtime, adoptIdentity, apply, badgeRows, buildStatus, classifyUpstreamError, createRaccoonAdapter, credentialPollMs, decodeJwtClaims, fetchCatalog, inject, name, parseDesktopAuth, parseModelCatalog, probeFingerprint, reasoningFields, resolveClientIdentity, resolveVision, startRaccoonShim, sweep, userDataCandidates, variantFor, visionOverridesOf };