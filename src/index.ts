/**
 * `dsh-raccoon-connect` — the 商汤小浣熊 desktop app's models as a DSH provider.
 *
 * Lifecycle in one paragraph, because the ordering is the design:
 *
 * 1. Register the provider **unconditionally** at startup, with an empty or
 *    built-in catalog. What varies is whether the model group is *visible*, not
 *    whether the provider exists — an empty catalog is how DSH hides a group, so
 *    a sign-in that happens after boot works without re-registering anything.
 * 2. Poll the credential files (never the network) to follow the desktop app's
 *    sign-in, sign-out, and account switch.
 * 3. On an identity change, adopt it: bump the generation (which is what makes an
 *    in-flight fetch from the previous account refuse to write back), serve that
 *    account's saved catalog if it has one, else the built-in roster, then fetch.
 * 4. Serve requests through a loopback shim so the real token never enters
 *    pi-ai, and refresh it through the store's single flight.
 *
 * Everything the plugin persists lives under `$DSH_HOME`: its own credential
 * copy, saved catalogs, probe records, the host heartbeat. No token is ever
 * written into a catalog or probe file.
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { RaccoonCredentialStore } from './auth.ts'
import type { RaccoonCredential } from './auth.ts'
import { createRaccoonAdapter } from './adapter.ts'
import { activeBadges, FALLBACK_CATALOG, isFree, isRateUnknown, multiplierLabel, RaccoonCatalog, RaccoonCatalogStore, supportsVision } from './catalog.ts'
import type { RaccoonCatalogModel, RaccoonCatalogSource, RaccoonVisionOverrides, SavedRaccoonCatalog } from './catalog.ts'
import { resolveClientIdentity } from './client-identity.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './heartbeat.ts'
import { RaccoonProbeService } from './probe-service.ts'
import { probeFingerprint, RaccoonProbeStore } from './probe-store.ts'
import { createProbeKey, registerRaccoonRoutes } from './routes.ts'
import { startRaccoonShim } from './shim.ts'
import type { RaccoonShim } from './shim.ts'
import { RaccoonUpstreamClient } from './upstream.ts'
import type { RaccoonProbeAction, RaccoonWebCatalog, RaccoonWebModelBadge, RaccoonWebPoints, RaccoonWebStatus } from './status-paths.ts'
import { RACCOON_PRIMARY } from './variants.ts'
import { RACCOON_CONNECT_VERSION } from './version.ts'

export { ALL_VARIANTS, RACCOON_PRIMARY, variantFor } from './variants.ts'
export { RACCOON_PROBE_PATH, RACCOON_STATUS_PATH } from './status-paths.ts'
export type { RaccoonWebStatus } from './status-paths.ts'
export { createRaccoonAdapter, reasoningFields } from './adapter.ts'
export { startRaccoonShim } from './shim.ts'
export { decodeJwtClaims, parseDesktopAuth, RaccoonCredentialStore } from './auth.ts'
export { FALLBACK_CATALOG, MEASURED_VISION, parseModelCatalog, RaccoonCatalog, resolveVision } from './catalog.ts'
export { probeFingerprint } from './probe-store.ts'
export { classifyUpstreamError, RaccoonUpstreamClient } from './upstream.ts'
export { resolveClientIdentity, userDataCandidates } from './client-identity.ts'

/** Stable Cordis plugin name; matches the `id` this bundle's patch inserts. */
export const name = 'llm-raccoon'

/** The LLM registry must exist before a provider can register into it. */
export const inject = ['llm']

/**
 * Settings namespace owning the card's section.
 *
 * The namespace is what makes the card *render*: the settings Plugins tab
 * dispatches `settings.plugin.item` by `entryKey = ns` for each served namespace
 * and skips a card whose key names no installed section. So one card needs one
 * section, and the section's schema must be split the same way as the card.
 */
export const RACCOON_SETTINGS_NS = 'raccoon' as SettingsNamespace

/**
 * How often the credential files are re-checked, in milliseconds.
 *
 * A boot-only read cannot notice a sign-in that happens while DSH is running, so
 * the group would stay hidden until restart. This poll touches at most two local
 * files: no network, no probe. `DSH_RACCOON_POLL_MS` overrides it for tests and
 * for watching a slow sign-in; the value is clamped so a typo cannot become a
 * busy loop.
 */
const CREDENTIAL_POLL_MS = 30_000
const MIN_POLL_MS = 100
const MAX_POLL_MS = 24 * 60 * 60 * 1000

/** Resolve the sweep interval, honoring the override when it is usable. */
export function credentialPollMs(): number {
  const raw = process.env['DSH_RACCOON_POLL_MS']
  if (raw === undefined || raw.trim() === '') return CREDENTIAL_POLL_MS
  const override = Number(raw)
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/**
 * How long to wait before retrying a catalog fetch that failed.
 *
 * A same-account token rotation carries no new model information, so the sweep
 * does not re-fetch on every tick. A *failed* fetch must not be treated the same
 * way: without a retry bound, one transient network blip at boot would leave the
 * group on the built-in roster until the user happened to press refresh.
 */
const CATALOG_RETRY_SWEEPS = 10

/** How long a fetched balance answer stays presentable before being re-read. */
const POINTS_TTL_MS = 60_000

/** Plugin configuration. */
export interface Config {
  /**
   * Explicit path to the desktop app's credential file, overriding
   * `RACCOON_AUTH_FILE`, `BOX_AGENT_CONFIG_DIR`, and the default
   * `~/.box-agent/config/auth.json`.
   */
  authFile?: string
  /**
   * Whether the user has standing authorization for reasoning-effort probes.
   * Off by default: each probe sends real requests that may spend credit.
   */
  probeConsent?: boolean
  /**
   * Model ids to be offered image input regardless of what the catalog tag says.
   *
   * The upstream's `vision` tag is its only capability field and is demonstrably
   * wrong on some rows, so the plugin ships measurements for the models it could
   * verify (`MEASURED_VISION`). This list is the rest of the gap: a newly listed
   * model that reads images but is untagged can be enabled here without waiting
   * for a plugin release.
   */
  visionModelIds?: string[]
  /**
   * Model ids to keep text-only. Wins over {@link visionModelIds} when an id
   * appears in both, because a refusal is a cheaper mistake than an image the
   * gateway silently discards.
   */
  textOnlyModelIds?: string[]
}

const AUTH_FILE_FIELD = z.string()
  .description('商汤小浣熊 credential file (defaults to the app\'s own ~/.box-agent/config/auth.json)')
const PROBE_CONSENT_FIELD = z.boolean().default(false)
  .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)')
const VISION_MODEL_IDS_FIELD = z.array(z.string()).default([])
  .description('模型 id 白名单：无视目录标签，一律按支持识图提供图片输入')
const TEXT_ONLY_MODEL_IDS_FIELD = z.array(z.string()).default([])
  .description('模型 id 黑名单：一律按纯文本提供，优先级高于识图白名单')

export const Config: z<Config> = z.object({
  authFile: AUTH_FILE_FIELD,
  probeConsent: PROBE_CONSENT_FIELD,
  visionModelIds: VISION_MODEL_IDS_FIELD,
  textOnlyModelIds: TEXT_ONLY_MODEL_IDS_FIELD,
})

/** The settings section: the same fields the card is allowed to edit. */
const SECTION: z<Config> = z.object({
  authFile: AUTH_FILE_FIELD,
  probeConsent: PROBE_CONSENT_FIELD,
  visionModelIds: VISION_MODEL_IDS_FIELD,
  textOnlyModelIds: TEXT_ONLY_MODEL_IDS_FIELD,
})

/**
 * The configuration as the catalog wants it.
 *
 * Ids are trimmed and blanks dropped: a hand-edited list with a stray empty entry
 * or trailing spaces should describe the models the user named, nothing more — an
 * empty id matching everything would be the one way this escape hatch could
 * silently switch capability off for the whole roster.
 */
export function visionOverridesOf(config: Config): RaccoonVisionOverrides {
  const idsOf = (ids: readonly string[] | undefined): string[] => (ids ?? [])
    .map(id => id.trim())
    .filter(id => id !== '')
  return { imageInput: idsOf(config.visionModelIds), textOnly: idsOf(config.textOnlyModelIds) }
}

/**
 * Everything the running plugin holds about one provider route.
 *
 * The mutable lifecycle fields are typed `T | undefined` rather than left
 * optional: clearing them (a fetch that stopped being relevant, a shim handed
 * back on disposal, an error that a later success supersedes) is the normal
 * transition, and `exactOptionalPropertyTypes` only allows that assignment when
 * the type says undefined is a value the field can hold.
 */
export interface Runtime {
  variant: typeof RACCOON_PRIMARY
  store: RaccoonCredentialStore
  client: RaccoonUpstreamClient
  catalog: RaccoonCatalog
  probeStore: RaccoonProbeStore
  probeService: RaccoonProbeService
  savedCatalogs: RaccoonCatalogStore
  /** Where the currently served models came from. */
  source: RaccoonCatalogSource
  fetchedAtMs?: number | undefined
  error?: string | undefined
  lastAttemptMs: number
  /**
   * Bumped on every identity transition. An in-flight fetch records the
   * generation it started under and writes nothing if that moved on — checking
   * identity alone is not enough, because two fetches for the *same* account can
   * still finish out of order and the older one would win.
   */
  generation: number
  inflight?: { identity: string, generation: number, promise: Promise<void> } | undefined
  account?: string | undefined
  registered: boolean
  invalidate?: (() => void) | undefined
  shim?: RaccoonShim | undefined
  points?: RaccoonWebPoints | undefined
  pointsError?: string | undefined
  pointsAtMs?: number | undefined
}

/** Build the runtime pieces that need no port and no registration. */
function createRuntime(config: Config, current: () => Config): Runtime {
  const client = new RaccoonUpstreamClient({ variant: RACCOON_PRIMARY, identity: resolveClientIdentity })
  const store = new RaccoonCredentialStore({
    variant: RACCOON_PRIMARY,
    refresh: token => client.refresh(token),
    ...(config.authFile === undefined ? {} : { desktopPath: config.authFile }),
  })
  const catalog = new RaccoonCatalog(() => new Date(), () => visionOverridesOf(current()))
  const probeStore = new RaccoonProbeStore(join(resolveDshHome(), RACCOON_PRIMARY.probeFilename))
  const savedCatalogs = new RaccoonCatalogStore(join(resolveDshHome(), RACCOON_PRIMARY.catalogFilename))
  const runtime: Runtime = {
    variant: RACCOON_PRIMARY,
    store,
    client,
    catalog,
    probeStore,
    savedCatalogs,
    // Placeholder, replaced two lines below: the service needs the runtime's own
    // notify hook, and the runtime needs the service.
    probeService: undefined as unknown as RaccoonProbeService,
    source: 'fallback',
    lastAttemptMs: 0,
    generation: 0,
    registered: false,
  }
  runtime.probeService = new RaccoonProbeService({
    catalog,
    store,
    upstream: client,
    probeStore,
    consent: () => current().probeConsent === true,
    pluginVersion: RACCOON_CONNECT_VERSION,
    notify: () => {
      runtime.invalidate?.()
    },
  })
  return runtime
}

/** Badge rows for the card, derived from the catalog as it stands right now. */
export function badgeRows(catalog: RaccoonCatalog, now = new Date()): RaccoonWebModelBadge[] {
  return catalog.current().map(model => {
    const rate = multiplierLabel(model)
    return {
      id: model.id,
      name: model.label === '' ? model.id : model.label,
      ...(rate === undefined ? {} : { credits: rate }),
      ...(isRateUnknown(model) ? { rateUnknown: true as const } : {}),
      ...(isFree(model) ? { free: true } : {}),
      badges: activeBadges(model, now),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      vision: supportsVision(model),
    }
  })
}

/** Serve the roster compiled into the plugin. */
function useFallback(runtime: Runtime): void {
  runtime.catalog.set({ models: FALLBACK_CATALOG })
  runtime.source = 'fallback'
  runtime.fetchedAtMs = undefined
  runtime.error = undefined
}

/**
 * Point the runtime at an account identity, invalidating what the previous one
 * left behind.
 *
 * One helper for all four transitions (sweep sign-in, sweep sign-out, manual
 * refresh, and a refresh that finds the user has signed out), because each of
 * them has to do the same six things and a path that forgets one leaks state
 * across accounts.
 */
export function adoptIdentity(runtime: Runtime, account: string | undefined): void {
  const changed = account !== runtime.account
  runtime.generation += 1
  runtime.inflight = undefined
  if (changed) {
    // Deliberately *not* clearing the probe store here. Observations are already
    // scoped per record — RaccoonProbeStore.get() refuses one whose stored account
    // differs — so a switch cannot leak an answer one account paid for. Clearing
    // on every change looked like the safe belt-and-braces, but the first adoption
    // after a cold start is `undefined → account` for the *same* account whose
    // sweep is sitting in the file: it threw away a credit-spending observation on
    // every restart, and the user had to re-run detection to get the control back.
    runtime.points = undefined
    runtime.pointsError = undefined
    runtime.pointsAtMs = undefined
    runtime.account = account
  }
  if (account === undefined) {
    runtime.catalog.hide()
    useFallback(runtime)
    runtime.invalidate?.()
    return
  }
  const saved: SavedRaccoonCatalog | undefined = runtime.savedCatalogs.get(account)
  if (saved !== undefined) {
    runtime.catalog.set({
      ...(saved.defaultModelId === undefined ? {} : { defaultModelId: saved.defaultModelId }),
      models: saved.models,
    })
    runtime.source = 'saved'
    runtime.fetchedAtMs = saved.fetchedAtMs
    runtime.error = undefined
  } else {
    useFallback(runtime)
  }
  runtime.catalog.show()
  runtime.invalidate?.()
}

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
export async function fetchCatalog(runtime: Runtime, account: string): Promise<void> {
  const inflight = runtime.inflight
  const generation = runtime.generation
  if (inflight !== undefined && inflight.identity === account && inflight.generation === generation) {
    await inflight.promise
    return
  }
  const promise = (async (): Promise<void> => {
    runtime.lastAttemptMs = Date.now()
    try {
      const credential: RaccoonCredential = await runtime.store.resolve()
      // The refresh above may have taken long enough for the account to change.
      if ((await runtime.store.current())?.accountId !== account || runtime.generation !== generation) return
      const document = await runtime.client.fetchCatalog(credential.accessToken)
      if ((await runtime.store.current())?.accountId !== account || runtime.generation !== generation) return
      runtime.catalog.set(document)
      runtime.catalog.show()
      runtime.source = 'live'
      runtime.fetchedAtMs = Date.now()
      runtime.error = undefined
      runtime.savedCatalogs.set(account, {
        version: 1,
        source: 'live',
        fetchedAtMs: runtime.fetchedAtMs,
        ...(document.defaultModelId === undefined ? {} : { defaultModelId: document.defaultModelId }),
        models: document.models,
      })
      runtime.invalidate?.()
    } catch (error: unknown) {
      // A failure keeps whatever is already on screen and records why, so the
      // card can say "stale" instead of looking like an offline guess.
      runtime.error = error instanceof Error ? error.message : String(error)
      runtime.invalidate?.()
    }
  })()
  runtime.inflight = { identity: account, generation, promise }
  try {
    await promise
  } finally {
    if (runtime.inflight?.promise === promise) runtime.inflight = undefined
  }
}

/**
 * One credential sweep: notice sign-in, sign-out, and account switches.
 *
 * Never refreshes anything itself (`current()`, not `resolve()`), so an idle
 * plugin makes no upstream calls; the fetch path does the renewing.
 */
export async function sweep(runtime: Runtime): Promise<void> {
  const credential = await runtime.store.current()
  const account = credential?.accountId
  if (account === undefined) {
    if (runtime.account !== undefined || runtime.catalog.visible) adoptIdentity(runtime, undefined)
    return
  }
  if (account !== runtime.account) {
    adoptIdentity(runtime, account)
    await fetchCatalog(runtime, account)
    return
  }
  if (runtime.source !== 'live' && Date.now() - runtime.lastAttemptMs >= CATALOG_RETRY_SWEEPS * credentialPollMs()) {
    await fetchCatalog(runtime, account)
  }
}

/** Build the document the settings card renders. Never throws. */
export async function buildStatus(runtime: Runtime, probeKey: string, consent: boolean, now = Date.now()): Promise<RaccoonWebStatus> {
  const summary = await runtime.store.status()
  if (summary.state === 'signed-out') {
    return { status: 'signed-out', ...(summary.reason === undefined ? {} : { reason: summary.reason }) }
  }
  // The balance call is best-effort and briefly cached: the card polls every
  // minute, and a billing endpoint that is down must not turn the card into an
  // error page while the models themselves are fine.
  if (runtime.pointsAtMs === undefined || now - runtime.pointsAtMs > POINTS_TTL_MS) {
    try {
      const credential = await runtime.store.resolve()
      runtime.points = await runtime.client.fetchBalance(credential.accessToken)
      runtime.pointsError = undefined
    } catch (error: unknown) {
      runtime.pointsError = error instanceof Error ? error.message : String(error)
    }
    runtime.pointsAtMs = now
  }
  const catalog: RaccoonWebCatalog = {
    source: runtime.source,
    ...(runtime.fetchedAtMs === undefined ? {} : { fetchedAt: runtime.fetchedAtMs }),
    ...(runtime.error === undefined ? {} : { error: runtime.error }),
  }
  return {
    status: 'signed-in',
    ...(summary.nickname === undefined ? {} : { nickname: summary.nickname }),
    ...(summary.identity === undefined ? {} : { identity: summary.identity }),
    ...(summary.orgName === undefined ? {} : { orgName: summary.orgName }),
    ...(summary.source === undefined ? {} : { source: summary.source }),
    ...(summary.expiresAtMs === undefined || summary.expiresAtMs <= 0 ? {} : { expiresAt: summary.expiresAtMs }),
    ...(summary.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: summary.refreshExpiresAtMs }),
    ...(runtime.points === undefined ? {} : { points: runtime.points }),
    ...(runtime.pointsError === undefined ? {} : { pointsError: runtime.pointsError }),
    catalog,
    models: badgeRows(runtime.catalog),
    probe: {
      consent,
      running: runtime.probeService.isRunning(),
      candidates: (await runtime.probeService.candidates()).map(candidate => candidate.id),
      results: await runtime.probeService.results(),
    },
    probeKey,
  }
}

/**
 * Register the provider and start its lifecycle.
 *
 * The adapter is constructed only once the shim holds a port, because pi-ai's
 * model descriptors capture the shim's base URL at construction time.
 * Registration is unconditional; catalog visibility is what gates the group.
 */
async function bootstrap(ctx: Context, runtime: Runtime): Promise<() => void> {
  const shim = await startRaccoonShim({
    accessToken: async () => (await runtime.store.resolve()).accessToken,
    upstream: runtime.client,
    catalog: () => runtime.catalog,
  })
  runtime.shim = shim
  const adapter = createRaccoonAdapter({
    providerId: RACCOON_PRIMARY.id,
    displayName: RACCOON_PRIMARY.displayName,
    shim,
    catalog: runtime.catalog,
    resolveAttachments: () => ctx.get('attachments'),
    observe: modelId => {
      const model = runtime.catalog.current().find(entry => entry.id === modelId)
      const account = runtime.account
      if (model === undefined || account === undefined) return undefined
      return runtime.probeStore.get(account, modelId, probeFingerprint(model))
    },
  })
  runtime.invalidate = () => {
    adapter.invalidate()
    ctx.emit('llm/adapters-updated')
  }

  let releaseAdapter: (() => void) | undefined
  let releaseDirectory: (() => void) | undefined
  try {
    releaseAdapter = ctx.llm.registerAdapter([RACCOON_PRIMARY.id], adapter.adapter)
    releaseDirectory = ctx.llm.registerConfigurableProviders([{
      provider: RACCOON_PRIMARY.id,
      displayName: RACCOON_PRIMARY.displayName,
      settingsNs: RACCOON_SETTINGS_NS,
      settingsPath: [],
      declared: false,
    }])
  } catch (error: unknown) {
    releaseAdapter?.()
    releaseDirectory?.()
    runtime.shim = undefined
    await shim.stop()
    throw error
  }
  runtime.registered = true
  writeHostHeartbeat(RACCOON_CONNECT_VERSION)
  ctx.logger.info(`dsh-raccoon-connect: registered ${RACCOON_PRIMARY.displayName} on loopback port ${shim.port()}`)

  return () => {
    releaseAdapter?.()
    releaseDirectory?.()
    runtime.registered = false
    runtime.invalidate = undefined
    runtime.shim = undefined
    clearHostHeartbeat()
    void shim.stop()
  }
}

/**
 * Plugin entry point.
 *
 * @param ctx - Cordis context owning this plugin's effects.
 * @param config - the applied configuration, live-replaced by the settings section.
 */
export function apply(ctx: Context, config: Config): void {
  let current = (): Config => config
  const runtime = createRuntime(config, () => current())
  const probeKey = createProbeKey()
  const timers: NodeJS.Timeout[] = []
  let stopped = false
  let disposeRegistration: (() => void) | undefined

  // Settings section (DSH >= 0.2.0): the old `settings.installSection` API was
  // removed with the settings-service rework. Newer kernels derive forms from
  // the Config schema itself, so registering a page policy is all that is left;
  // without a settings service the plugin still serves models, just with no
  // user-editable fields. Kept inside `inject` so a profile without the
  // service never fails to mount.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.configure({ auto: true })
  })

  // Same-origin routes behind the card. Optional: a profile with no web server
  // (Desktop file:// + IPC, or TUI) simply gets no card data source.
  ctx.inject(['webServer'], webCtx => {
    const dispose = registerRaccoonRoutes(webCtx.webServer, {
      statusPath: RACCOON_PRIMARY.statusPath,
      probePath: RACCOON_PRIMARY.probePath,
      probeKey,
      buildStatus: () => buildStatus(runtime, probeKey, current().probeConsent === true),
      handleAction: async (action: RaccoonProbeAction) => {
        if (action.action === 'clear') {
          await runtime.probeService.clear()
          return { ok: true }
        }
        if (action.action === 'refresh') {
          const credential = await runtime.store.current()
          adoptIdentity(runtime, credential?.accountId)
          if (credential !== undefined) await fetchCatalog(runtime, credential.accountId)
          return { ok: true, source: runtime.source }
        }
        const model = action.model
        if (model === undefined || model === '') return { ok: false, error: 'model is required' }
        const result = await runtime.probeService.probe(model, true)
        return result.ok ? { ok: true } : { ok: false, error: `probe not run: ${result.reason}` }
      },
    })
    return () => dispose()
  })

  const start = async (): Promise<void> => {
    try {
      disposeRegistration = await bootstrap(ctx, runtime)
    } catch (error: unknown) {
      ctx.logger.error('dsh-raccoon-connect: provider registration failed', error)
      return
    }
    if (stopped) {
      disposeRegistration()
      return
    }
    await sweep(runtime).catch((error: unknown) => ctx.logger.error('dsh-raccoon-connect: initial sweep failed', error))
    timers.push(setInterval(() => {
      void sweep(runtime).catch((error: unknown) => ctx.logger.error('dsh-raccoon-connect: credential sweep failed', error))
    }, credentialPollMs()))
  }
  void start()

  ctx.effect(() => () => {
    stopped = true
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    disposeRegistration?.()
    clearHostHeartbeat()
  })
}
