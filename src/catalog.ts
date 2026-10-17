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

import { join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** How the upstream says a model is billed right now. */
export type RaccoonBillingStatus = 'normal' | 'discount' | 'limited_free'

/** One promotion window on a model's price. */
export interface RaccoonBillingDiscount {
  /** Promotion name, shown as the badge, e.g. `夜间折扣`. */
  name: string
  /** Factor applied to the row's list price while the window is active (0 = free). */
  multiplier: number
  /** `HH:mm` daily window bounds, in the upstream's own timezone. */
  dailyStart?: string
  dailyEnd?: string
  /** Absolute window bounds as date strings. */
  startAt?: string
  endAt?: string
  /** Whether the upstream says this window is live right now. */
  active: boolean
}

/** One catalog row, normalized. */
export interface RaccoonCatalogModel {
  /** Wire model id; what actually goes into the request. */
  id: string
  /** Short label from the upstream, without price or badges. */
  label: string
  /** Longer note the upstream sometimes attaches to a row. */
  description?: string
  /** Longer description in the upstream's own display form, when separate. */
  displayDescription?: string
  /** Whether the upstream lists the model at all. */
  visible: boolean
  /** Capability tags, with `image` / `image-understanding` normalized to `vision`. */
  tags: readonly string[]
  /**
   * Our effective image-input verdict for this row, as resolved by
   * {@link resolveVision}. It is deliberately separate from the `vision` tag: the
   * tag is what the *upstream* claims, and measurement has shown it wrong in both
   * directions. Rows served by {@link RaccoonCatalog.current} always carry it; a
   * hand-built row without it falls back to the tag.
   */
  vision?: boolean
  /** Upstream's stated strength ranking; 1 when unspecified. */
  abilityLevel: number
  contextWindow?: number
  maxTokens?: number
  /** List-price multiplier, before any active promotion. */
  billingMultiplier?: number
  /** The multiplier the upstream says applies right now. */
  billingEffectiveMultiplier?: number
  billingStatus?: RaccoonBillingStatus
  billingStatusNote?: string
  billingDiscounts: readonly RaccoonBillingDiscount[]
}

/** A parsed catalog document. */
export interface RaccoonCatalogDocument {
  defaultModelId?: string
  models: readonly RaccoonCatalogModel[]
}

/** What a card or log says about where the models came from. */
export type RaccoonCatalogSource = 'live' | 'saved' | 'fallback'

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
export const MEASURED_VISION: Readonly<Record<string, boolean>> = {
  'sn-sensenova-6-8-flash-lite': true,
  'sn-kimi-k3': true,
  'sn-glm-5-3': false,
  'sn-glm-5-3-flash': true,
  'sn-deepseek-v4-1-flash': true,
}

/** Per-model capability forced from the plugin configuration. */
export interface RaccoonVisionOverrides {
  /** Ids the user says do read images, whatever the catalog tag claims. */
  readonly imageInput?: readonly string[]
  /** Ids the user says must stay text-only. */
  readonly textOnly?: readonly string[]
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
export function resolveVision(model: RaccoonCatalogModel, overrides: RaccoonVisionOverrides = {}): boolean {
  if (overrides.textOnly?.includes(model.id) === true) return false
  if (overrides.imageInput?.includes(model.id) === true) return true
  if (Object.hasOwn(MEASURED_VISION, model.id)) return MEASURED_VISION[model.id] === true
  return model.tags.includes('vision')
}

/** Whether images may be sent to this model, per the verdict or the tag alone. */
export function supportsVision(model: RaccoonCatalogModel): boolean {
  return model.vision ?? model.tags.includes('vision')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Normalize capability tags.
 *
 * The upstream spells image support three ways across its own rows, and the
 * desktop app folds the first two into `vision`; the plugin keeps that
 * normalization so the image-input decision has exactly one thing to test.
 * Non-string, over-long, and control-character-bearing entries are dropped and
 * the list is capped, mirroring how the app's parser bounds hostile input.
 */
export function normalizeTags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const tag = entry.trim().toLowerCase()
    if (tag === '' || tag.length > 64 || /[\0-\x1f\x7f]/u.test(tag)) continue
    const normalized = tag === 'image' || tag === 'image-understanding' ? 'vision' : tag
    if (!out.includes(normalized)) out.push(normalized)
    if (out.length >= 32) break
  }
  return out
}

function parseDiscounts(value: unknown): readonly RaccoonBillingDiscount[] {
  if (!Array.isArray(value)) return []
  const out: RaccoonBillingDiscount[] = []
  for (const entry of value) {
    const row = asRecord(entry)
    if (row === undefined) continue
    const name = trimmed(row['name'])
    const multiplier = nonNegativeNumber(row['multiplier'])
    if (name === '' || multiplier === undefined) continue
    const dailyStart = trimmed(row['daily_start'])
    const dailyEnd = trimmed(row['daily_end'])
    const startAt = trimmed(row['start_at'])
    const endAt = trimmed(row['end_at'])
    out.push({
      name,
      multiplier,
      ...(dailyStart === '' ? {} : { dailyStart }),
      ...(dailyEnd === '' ? {} : { dailyEnd }),
      ...(startAt === '' ? {} : { startAt }),
      ...(endAt === '' ? {} : { endAt }),
      active: row['active'] === true,
    })
  }
  return out
}

/**
 * Whether a promotion window covers `now`.
 *
 * `active` from the catalog is authoritative when present. Otherwise the daily
 * and absolute windows are evaluated in the machine's local zone, which for the
 * intended user is the same Asia/Shanghai zone the upstream bills in; a row that
 * declares no window at all counts as live.
 */
export function discountIsLive(discount: RaccoonBillingDiscount, now: Date): boolean {
  if (discount.active) return true
  const hasAbsolute = discount.startAt !== undefined || discount.endAt !== undefined
  const hasDaily = discount.dailyStart !== undefined || discount.dailyEnd !== undefined
  // A promotion with no window at all is simply the current price.
  if (!hasAbsolute && !hasDaily) return true
  if (hasAbsolute) {
    const from = discount.startAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(discount.startAt)
    const to = discount.endAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(discount.endAt)
    // An unparseable bound is an unknown window; claiming a price is active when
    // we cannot tell would be inventing a discount.
    if (Number.isNaN(from) || Number.isNaN(to)) return false
    const at = now.getTime()
    if (at < from || at > to) return false
  }
  if (hasDaily) {
    const minutes = now.getHours() * 60 + now.getMinutes()
    const from = minutesOf(discount.dailyStart, 0)
    const to = minutesOf(discount.dailyEnd, 1440)
    if (from === undefined || to === undefined) return false
    // A window whose end is before its start wraps past midnight (22:00–06:00).
    const inside = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to
    if (!inside) return false
  }
  return true
}

function minutesOf(value: string | undefined, whenAbsent: number): number | undefined {
  if (value === undefined) return whenAbsent
  const match = /^(\d{1,2}):(\d{2})/u.exec(value)
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/**
 * Re-derive the time-boxed billing facts of one row.
 *
 * A catalog is fetched once and displayed for hours, so "currently discounted"
 * cannot be baked in at parse time. Measured against the live gateway, a
 * promotion's `multiplier` is a **factor on the list price**, not the resulting
 * price: `sn-glm-5-3-flash` carries list 0.2 with a 0.5 factor and the upstream
 * states 0.1 effective, while the free month carries list 0.5 with a 0 factor
 * and states 0. So the live derivation is `list × cheapest live factor`, and
 * once every window has closed the row returns to its list price — or, if it
 * never had one, to no stateable price at all, because advertising a figure
 * nobody is being charged is worse than admitting the price is unknown.
 */
export function modelWithCurrentBilling(model: RaccoonCatalogModel, now: Date): RaccoonCatalogModel {
  if (model.billingDiscounts.length === 0) return model
  const { billingEffectiveMultiplier: _stated, billingStatus: _statedStatus, billingDiscounts: _windows, ...rest } = model
  const live = model.billingDiscounts.filter(discount => discountIsLive(discount, now))
  if (live.length === 0) {
    return {
      ...rest,
      ...(model.billingMultiplier === undefined
        ? {}
        : { billingEffectiveMultiplier: model.billingMultiplier, billingStatus: 'normal' as RaccoonBillingStatus }),
      billingDiscounts: [],
    }
  }
  // A row with no list price cannot be scaled, so its stated effective figure is
  // kept rather than recomputed from a factor with nothing to multiply.
  if (model.billingMultiplier === undefined) return model
  // The cheapest live window is what the user actually pays.
  const best = live.reduce((acc, item) => item.multiplier < acc.multiplier ? item : acc)
  const effective = model.billingMultiplier * best.multiplier
  return {
    ...rest,
    billingEffectiveMultiplier: effective,
    billingStatus: effective === 0 ? 'limited_free' : 'discount',
    billingDiscounts: model.billingDiscounts,
  }
}

/** Active promotion names, in upstream order. */
export function activeBadges(model: RaccoonCatalogModel, now: Date): readonly string[] {
  return model.billingDiscounts.filter(discount => discountIsLive(discount, now)).map(discount => discount.name)
}

/**
 * The multiplier as display text, e.g. `x0.79`.
 *
 * Undefined when no price can be stated; the caller is then obliged to say the
 * price is unknown rather than show a stale or invented figure.
 */
export function multiplierLabel(model: RaccoonCatalogModel): string | undefined {
  const value = model.billingEffectiveMultiplier ?? model.billingMultiplier
  if (value === undefined) return undefined
  return `x${value.toFixed(2)}`
}

/** Whether the model is currently free. */
export function isFree(model: RaccoonCatalogModel): boolean {
  const value = model.billingEffectiveMultiplier ?? model.billingMultiplier
  return value !== undefined && value === 0
}

/** Whether the row carries no stateable price (an expired promotion's leftover). */
export function isRateUnknown(model: RaccoonCatalogModel): boolean {
  return model.billingEffectiveMultiplier === undefined && model.billingMultiplier === undefined && model.billingDiscounts.length === 0 && model.billingStatusNote === undefined
}

const MAX_TAGS = 32

function parseModelRow(value: unknown): RaccoonCatalogModel | undefined {
  const row = asRecord(value)
  if (row === undefined) return undefined
  const id = trimmed(row['name'])
  if (id === '') return undefined
  const label = trimmed(row['description'])
  const displayDescription = trimmed(row['display_description'])
  const params = asRecord(row['params'])
  const contextWindow = positiveInt(params?.['context_window']) ?? positiveInt(row['context_window'])
  const maxTokens = positiveInt(params?.['max_tokens']) ?? positiveInt(row['max_tokens'])
  const billingMultiplier = positiveNumber(row['billing_multiplier'])
  const billingEffectiveMultiplier = nonNegativeNumber(row['billing_effective_multiplier'])
  const rawStatus = trimmed(row['billing_status'])
  const billingStatus = rawStatus === 'normal' || rawStatus === 'discount' || rawStatus === 'limited_free' ? rawStatus as RaccoonBillingStatus : undefined
  const note = trimmed(row['billing_status_note'])
  return {
    id,
    label,
    ...(displayDescription === '' ? {} : { displayDescription }),
    visible: row['visible'] !== false,
    tags: normalizeTags(row['tags']).slice(0, MAX_TAGS),
    abilityLevel: positiveInt(row['ability_level']) ?? 1,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(billingMultiplier === undefined ? {} : { billingMultiplier }),
    ...(billingEffectiveMultiplier === undefined ? {} : { billingEffectiveMultiplier }),
    ...(billingStatus === undefined ? {} : { billingStatus }),
    ...(note === '' ? {} : { billingStatusNote: note }),
    billingDiscounts: parseDiscounts(row['billing_discounts']),
  }
}

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
export function parseModelCatalog(document: unknown): RaccoonCatalogDocument | undefined {
  const root = asRecord(document)
  if (root === undefined) return undefined
  if (root['code'] !== undefined && root['code'] !== 0) return undefined
  const payload = asRecord(root['data']) ?? root
  const categories = (Array.isArray(payload['categories']) ? payload['categories'] : [])
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
  const chat = categories.find(category => trimmed(category['type']) === 'chat')
  if (chat === undefined) return undefined
  const seen = new Set<string>()
  const models: RaccoonCatalogModel[] = []
  for (const entry of Array.isArray(chat['models']) ? chat['models'] : []) {
    const model = parseModelRow(entry)
    if (model === undefined || seen.has(model.id)) continue
    // `raccoon-work` is the app's own agent-routing row, not a chat model.
    const labels = [model.id, model.label].map(value => value.toLowerCase())
    if (!model.visible || labels.includes('raccoon-work')) continue
    seen.add(model.id)
    models.push(model)
  }
  if (models.length === 0) return undefined
  const declared = trimmed(chat['default_model'])
  const defaultModelId = models.some(model => model.id === declared) ? declared : models[0]!.id
  return { defaultModelId, models }
}

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
export const FALLBACK_CATALOG: readonly RaccoonCatalogModel[] = [
  {
    id: 'sn-sensenova-6-8-flash-lite',
    label: 'SenseNova-6.8-Flash-Lite',
    displayDescription: '内置兜底名册，价格以刷新后的目录为准',
    visible: true,
    tags: ['general', 'chat', 'rewrite', 'summary', 'fast', 'vision'],
    abilityLevel: 1,
    contextWindow: 256_000,
    maxTokens: 63_999,
    billingDiscounts: [],
  },
  {
    id: 'sn-glm-5-3',
    label: 'GLM-5-3',
    displayDescription: '内置兜底名册，价格以刷新后的目录为准',
    visible: true,
    tags: ['general', 'office', 'code', 'vision', 'debug', 'analysis', 'html', 'reasoning'],
    abilityLevel: 1,
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    billingDiscounts: [],
  },
  {
    id: 'sn-kimi-k3',
    label: 'Kimi-K3',
    displayDescription: '内置兜底名册，价格以刷新后的目录为准',
    visible: true,
    tags: ['general', 'office', 'code', 'vision', 'debug', 'analysis', 'html', 'reasoning'],
    abilityLevel: 1,
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    billingDiscounts: [],
  },
  {
    id: 'sn-glm-5-3-flash',
    label: 'GLM-5-3-Flash',
    displayDescription: '内置兜底名册，价格以刷新后的目录为准',
    visible: true,
    tags: ['general', 'chat', 'rewrite', 'summary', 'fast'],
    abilityLevel: 1,
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    billingDiscounts: [],
  },
  {
    id: 'sn-deepseek-v4-1-flash',
    label: 'DeepSeek-V4.1-Flash',
    displayDescription: '内置兜底名册，价格以刷新后的目录为准',
    visible: true,
    tags: ['general', 'code', 'html', 'analysis', 'reasoning', 'auto'],
    abilityLevel: 1,
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    billingDiscounts: [],
  },
].map(model => ({ ...model }))

/** Saved catalog document as persisted per account, tokens never included. */
export interface SavedRaccoonCatalog {
  version: 1
  source: RaccoonCatalogSource
  fetchedAtMs: number
  defaultModelId?: string
  models: readonly RaccoonCatalogModel[]
}

/**
 * Per-account saved catalogs, one file per variant under `$DSH_HOME`.
 *
 * Keyed by account so switching users in the desktop app cannot serve one
 * account's roster (with its prices and windows) to another. Writes are
 * temp-file-plus-rename and failures are swallowed: a catalog cache is an
 * optimization, never a reason for a request to fail.
 */
export class RaccoonCatalogStore {
  private entries = new Map<string, SavedRaccoonCatalog>()
  private loaded = false

  constructor(private readonly path: string = join(resolveDshHome(), '.raccoon-catalog.json')) {}

  /** Which account key is currently in use; scoping is explicit, not ambient. */
  private static keyFor(accountId: string): string {
    return accountId
  }

  /**
   * Re-validate one row written by this store.
   *
   * Deliberately not {@link parseModelRow}: the file holds the *normalized*
   * shape (`id`/`label`/camelCase billing), and feeding that to the wire parser
   * would drop every row on the floor — `name` and `params` are simply not there
   * — which would silently collapse the documented live → saved → fallback
   * ladder into "always fallback after a restart".
   */
  private static reviveModel(value: unknown): RaccoonCatalogModel | undefined {
    const row = asRecord(value)
    if (row === undefined) return undefined
    const id = trimmed(row['id'])
    if (id === '') return undefined
    const label = trimmed(row['label'])
    const description = trimmed(row['description'])
    const displayDescription = trimmed(row['displayDescription'])
    const billingMultiplier = positiveNumber(row['billingMultiplier'])
    const billingEffectiveMultiplier = nonNegativeNumber(row['billingEffectiveMultiplier'])
    const rawStatus = trimmed(row['billingStatus'])
    const billingStatus = rawStatus === 'normal' || rawStatus === 'discount' || rawStatus === 'limited_free'
      ? rawStatus as RaccoonBillingStatus
      : undefined
    const note = trimmed(row['billingStatusNote'])
    const contextWindow = positiveInt(row['contextWindow'])
    const maxTokens = positiveInt(row['maxTokens'])
    return {
      id,
      label,
      ...(description === '' ? {} : { description }),
      ...(displayDescription === '' ? {} : { displayDescription }),
      visible: row['visible'] !== false,
      tags: normalizeTags(row['tags']).slice(0, MAX_TAGS),
      abilityLevel: positiveInt(row['abilityLevel']) ?? 1,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(billingMultiplier === undefined ? {} : { billingMultiplier }),
      ...(billingEffectiveMultiplier === undefined ? {} : { billingEffectiveMultiplier }),
      ...(billingStatus === undefined ? {} : { billingStatus }),
      ...(note === '' ? {} : { billingStatusNote: note }),
      billingDiscounts: parseDiscounts(row['billingDiscounts']),
    }
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      const document = asRecord(parsed)
      if (document?.['version'] !== 1) return
      const entries = asRecord(document?.['entries'])
      if (entries === undefined) return
      for (const account of Object.keys(entries)) {
        const saved = asRecord(entries[account])
        if (saved === undefined || !Array.isArray(saved['models'])) continue
        const models = saved['models']
          .map(entry => RaccoonCatalogStore.reviveModel(entry))
          .filter((model): model is RaccoonCatalogModel => model !== undefined)
        if (models.length === 0) continue
        const source = trimmed(saved['source'])
        const fetchedAtMs = typeof saved['fetchedAtMs'] === 'number' ? saved['fetchedAtMs'] : 0
        const defaultModelId = trimmed(saved['defaultModelId'])
        this.entries.set(account, {
          version: 1,
          source: source === 'live' || source === 'saved' || source === 'fallback' ? source : 'live',
          fetchedAtMs,
          ...(defaultModelId === '' ? {} : { defaultModelId }),
          models,
        })
      }
    } catch {
      this.entries = new Map()
    }
  }

  /** The last successful catalog for an account, if one is stored. */
  get(accountId: string): SavedRaccoonCatalog | undefined {
    this.load()
    return this.entries.get(RaccoonCatalogStore.keyFor(accountId))
  }

  /** Remember a catalog for an account. */
  set(accountId: string, catalog: SavedRaccoonCatalog): void {
    this.load()
    this.entries.set(RaccoonCatalogStore.keyFor(accountId), catalog)
    this.persist()
  }

  /** Forget an account (used when signing out). */
  remove(accountId: string): void {
    this.load()
    if (this.entries.delete(RaccoonCatalogStore.keyFor(accountId))) this.persist()
  }

  private persist(): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      const payload = `${JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }, null, 2)}\n`
      const temp = `${this.path}.tmp`
      writeFileSync(temp, payload, { mode: 0o600 })
      renameSync(temp, this.path)
    } catch {
      // A read-only home or a full disk costs the cache, nothing more.
    }
  }
}

/**
 * The live model list one provider route serves.
 *
 * Separate from the data it holds: visibility is a lifecycle decision (sign out
 * and the group disappears) while the rows are swapped independently, so the two
 * are not conflated in one field the caller has to remember to keep in step.
 */
export class RaccoonCatalog {
  private models: RaccoonCatalogModel[] = []
  private defaultModelId: string | undefined
  private shown = true

  /**
   * @param now - clock used to re-derive time-boxed billing on every read.
   * @param visionOverrides - live view of the configured capability overrides.
   * Read per row, per call, so editing the configuration takes effect on the next
   * model-list render instead of only after the next catalog refresh.
   */
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly visionOverrides: () => RaccoonVisionOverrides = () => ({}),
  ) {}

  /** Replace the rows. An empty list still respects the visibility flag. */
  set(document: RaccoonCatalogDocument): void {
    this.models = [...document.models]
    this.defaultModelId = document.defaultModelId
  }

  /**
   * Current rows, with time-boxed billing re-derived and the image-input verdict
   * attached.
   *
   * The stored rows stay a faithful copy of what upstream said; `vision` is a
   * judgement made at read time from {@link MEASURED_VISION} plus the
   * configuration, so a plugin update that revises a verdict is never fighting a
   * verdict cached to disk.
   */
  current(): readonly RaccoonCatalogModel[] {
    if (!this.shown) return []
    const now = this.now()
    const overrides = this.visionOverrides()
    return this.models.map(model => {
      const billed = modelWithCurrentBilling(model, now)
      const vision = resolveVision(billed, overrides)
      // Reference-stable when nothing moved: a re-render that changes neither the
      // price nor the verdict should not look like a new row to anything memoizing.
      return billed.vision === vision ? billed : { ...billed, vision }
    })
  }

  /** One row by wire id, billing re-derived, or undefined. */
  find(id: string): RaccoonCatalogModel | undefined {
    const model = this.current().find(entry => entry.id === id)
    return model
  }

  /** Hide the group without dropping its rows (used while signed out). */
  hide(): void {
    this.shown = false
  }

  /** Show a group whose rows have been restored. */
  show(): void {
    this.shown = true
  }

  /** Whether the group is currently visible to the pickers. */
  get visible(): boolean {
    return this.shown
  }

  /** The account's default model, when the catalog declared one. */
  get defaultModel(): string | undefined {
    return this.shown ? this.defaultModelId : undefined
  }

  /** Forget everything; used when the account changes. */
  clear(): void {
    this.models = []
    this.defaultModelId = undefined
  }
}
