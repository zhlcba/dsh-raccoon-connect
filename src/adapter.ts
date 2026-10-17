/**
 * The `raccoon` pi-ai provider: a loopback-backed adapter registered into the
 * Harness LLM seam, assembled from `dsh-llm-pi-ai`'s public extension points.
 *
 * Two decisions here are load-bearing rather than stylistic:
 *
 * - **The profile is hand-built.** `dsh-llm-pi-ai`'s own `resolveProfiles()` is
 *   not on its public export surface, so every field the profile type has made
 *   required over time has to be adopted at this call site. That is deliberate
 *   coupling: a new required field should fail loudly here rather than silently
 *   change what the route sends.
 * - **The displayed name carries the price.** Since DSH 0.1.2 the composer's
 *   model seat renders `model.name` only, so a rate that lives in `description`
 *   is invisible exactly where users pick models. The wire request is built from
 *   `model.id`, and nothing in the harness resolves a model by name, so the
 *   suffix is display-only and cannot affect routing.
 */

import { randomUUID } from 'node:crypto'
import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { RaccoonCatalog, RaccoonCatalogModel } from './catalog.ts'
import { activeBadges, isFree, isRateUnknown, multiplierLabel, supportsVision } from './catalog.ts'
import type { RaccoonProbeRecord } from './probe-store.ts'
import type { RaccoonShim } from './shim.ts'

/** Provider idle ceiling while one stream read is outstanding. */
export const RACCOON_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Image-request budgets at the dsh-llm-pi-ai defaults (the profile type made
 * them required in 0.1.1-rc.2). They bound requests to models whose image-input
 * verdict ({@link supportsVision}, measured rather than tag-governed) says they
 * read images; the rest are described as text-only to pi-ai, so an image never
 * reaches them in the first place.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane.
 *
 * The route authenticates solely through the shim's per-process shared secret,
 * which `resolveApiKey` supplies, so pi-ai's own credential lifecycle and
 * ambient discovery must never manufacture state for it. `PiAiAdapterOptions.auth`
 * is required since 0.1.1-rc.2, so every ambient question is answered as
 * "nothing stored, nothing set" rather than left to pi-ai's in-memory default.
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-raccoon-connect: the raccoon route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** Subscription-style billing: per-token pricing is unknowable, so report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Separator between a model's name and its display suffix. */
const RATE_SEPARATOR = ' · '

/**
 * The catalog display suffix: rate, then promotion badges.
 *
 * `x0.00` and `限时免费` are the upstream's own numbers and labels. A row whose
 * only price came from an expired promotion contributes nothing here — the card
 * says "价格未知", but silently dropping a stale figure from the picker is better
 * than continuing to advertise a price nobody is paying.
 */
function displaySuffix(model: RaccoonCatalogModel, now: Date): string | undefined {
  const parts: string[] = []
  if (!isRateUnknown(model)) {
    const rate = multiplierLabel(model)
    if (rate !== undefined) parts.push(rate)
  }
  parts.push(...activeBadges(model, now))
  return parts.length === 0 ? undefined : parts.join(RATE_SEPARATOR)
}

/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(model: RaccoonCatalogModel, now: Date): string {
  const base = model.label === '' ? model.id : model.label
  const suffix = displaySuffix(model, now)
  return suffix === undefined ? base : `${base}${RATE_SEPARATOR}${suffix}`
}

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
export function reasoningFields(observed?: RaccoonProbeRecord): { reasoning: boolean, thinkingLevelMap?: ThinkingLevelMap } {
  if (observed === undefined || observed.validation !== 'validating' || observed.efforts.length === 0) {
    return { reasoning: false }
  }
  const has = (level: string): boolean => observed.efforts.includes(level)
  const map: Record<ModelThinkingLevel, string | null> = {
    off: null,
    minimal: null,
    low: has('low') ? 'low' : null,
    medium: has('medium') ? 'medium' : null,
    high: has('high') ? 'high' : null,
    xhigh: has('xhigh') ? 'xhigh' : null,
    max: has('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/** Constructor dependencies. */
export interface RaccoonAdapterOptions {
  providerId: string
  displayName: string
  shim: RaccoonShim
  catalog: RaccoonCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Look up a local probe observation for a model. */
  observe?: (modelId: string) => RaccoonProbeRecord | undefined
}

/** What {@link createRaccoonAdapter} hands back. */
export interface RaccoonAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(
  model: RaccoonCatalogModel,
  baseUrl: string,
  now: Date,
  observed?: RaccoonProbeRecord,
  providerId = 'raccoon',
): Model<Api> {
  return {
    id: model.id,
    name: withCatalogDisplay(model, now),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: supportsVision(model) ? ['text', 'image'] : ['text'],
    ...reasoningFields(observed),
    cost: NO_COST,
    // pi-ai needs a window; an undeclared row falls back to the gateway's own
    // smallest documented envelope rather than an invented-large one, because
    // over-claiming a window produces context-overflow failures mid-conversation.
    contextWindow: model.contextWindow ?? 32_768,
    maxTokens: model.maxTokens ?? 8_192,
    // pi-ai cannot infer the field spelling from a random loopback URL, so name
    // the field the upstream requires.
    compat: { maxTokensField: 'max_tokens' },
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter.
 *
 * `getModels` is delegated to a live catalog read, so stream dispatch runs
 * through the constructed provider while the catalog answer tracks the upstream
 * refresh. `baseUrl` is re-resolved per read because the shim's port is
 * ephemeral and the provider is built once.
 */
export function createRaccoonAdapter(options: RaccoonAdapterOptions): RaccoonAdapter {
  const { shim, catalog, resolveAttachments, observe } = options
  const now = () => new Date()

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL, so the
    // shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    const stamp = now()
    return catalog.current().map(model => toPiModel(model, baseUrl, stamp, observe?.(model.id), options.providerId))
  }

  const base = createProvider({
    id: options.providerId,
    name: options.displayName,
    auth: {
      apiKey: {
        name: '小浣熊 OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: '小浣熊' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: options.providerId,
    displayName: options.displayName,
    streamIdleTimeoutMs: RACCOON_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-raccoon-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    // Required since 0.1.5-alpha.2: per-model upstream failures reported at
    // catalog time. Nothing here pre-rejects a model, so the map stays empty.
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[options.providerId, profile]])

  const adapter = new RaccoonPiAiAdapter(catalog, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    // The shim's per-process secret travels as the OpenAI apiKey; the real
    // 小浣熊 token is resolved by the shim itself and never enters pi-ai.
    resolveApiKey: async () => shim.token(),
    ...(resolveAttachments === undefined ? {} : { resolveAttachments }),
  })

  return {
    adapter,
    invalidate: () => {
      // A new Map identity is what makes PiAiAdapter rebuild its snapshot; the
      // profile object itself is unchanged because `getModels` reads live.
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[options.providerId, profile]])
    },
  }
}

/**
 * `PiAiAdapter` with the billing rate folded into the catalog answers the DSH
 * pickers see.
 *
 * Both overrides delegate to `super` and rewrite display fields only, so
 * streaming, capability resolution, and effort mapping stay exactly as
 * `dsh-llm-pi-ai` implements them. A model missing from the catalog falls
 * through untouched rather than being dropped: catalog membership is advisory
 * and the seam tolerates serving an unlisted id.
 */
class RaccoonPiAiAdapter extends PiAiAdapter {
  constructor(
    private readonly catalog: RaccoonCatalog,
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
  }

  private infoFor(model: string): RaccoonCatalogModel | undefined {
    return this.catalog.current().find(entry => entry.id === model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    const now = new Date()
    return models.map(model => {
      const info = this.infoFor(model.id)
      if (info === undefined) return model
      return { ...model, name: withCatalogDisplay(info, now) }
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    return { ...resolved, name: withCatalogDisplay(info, new Date()) }
  }
}

/** A stable id for one registration; useful in diagnostics. */
export function newRegistrationId(): string {
  return randomUUID()
}

/** Whether a model's rate should be displayed as free (`x0.00`). */
export function displaysAsFree(model: RaccoonCatalogModel): boolean {
  return isFree(model)
}
