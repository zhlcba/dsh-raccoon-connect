/**
 * The 小浣熊 upstream client: catalog, chat streaming, token refresh, balance.
 *
 * The gateway is genuinely OpenAI-compatible at
 * `https://xiaohuanxiong.com/api/web/llm/v2` (the desktop app's own local agent
 * talks to it that way), so this module is thin where WorkBuddy's was not: no
 * forced streaming, no `tool_choice` flattening, no role renaming. What it does
 * own is everything a third-party caller cannot infer — the auth and identity
 * headers, the `{code, message, data}` envelope, the business codes that mean
 * "out of credit" rather than "bad request", and the read-the-first-SSE-event
 * protocol the reasoning-effort probe depends on.
 *
 * @module dsh-raccoon-connect/upstream
 */

import type { RaccoonWebPoints } from './status-paths.ts'
import type { RaccoonVariant } from './variants.ts'
import type { RaccoonClientIdentity } from './client-identity.ts'
import { parseModelCatalog } from './catalog.ts'
import type { RaccoonCatalogDocument } from './catalog.ts'
import type { RaccoonRefreshOutcome } from './auth.ts'

/** What went wrong upstream, in the plugin's own vocabulary. */
export type RaccoonErrorKind = 'session_dead' | 'hard_credit' | 'soft_rate' | 'not_found' | 'server' | 'client'

/**
 * HTTP status the local shim re-exposes each kind as.
 *
 * The shim's caller is pi-ai's OpenAI client, which decides retry and error
 * presentation from the status code, so kinds are mapped back onto the codes an
 * OpenAI client already interprets correctly: 401/402/429 are terminal or
 * retryable in exactly the ways the plugin wants them to be.
 */
export const KIND_STATUS: Record<RaccoonErrorKind, number> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

/** Business codes meaning the session is gone and the app must sign in again. */
const SESSION_DEAD_CODES = new Set(['200003', '200822'])

/** Business codes and phrases meaning the account is out of credit. */
const CREDIT_CODES = new Set(['200402', '200429', '100402'])
const CREDIT_PHRASES = ['积分不足', '余额不足', '点数不足', 'quota exceeded', 'insufficient balance', 'insufficient points', 'payment required']

/** Business codes and phrases meaning "rate limited, try later". */
const RATE_PHRASES = ['频繁', 'too many requests', 'rate limit']

function codeOf(parsed: Record<string, unknown>): string {
  const code = parsed['code']
  if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  if (typeof code === 'string') return code
  return ''
}

function messageOf(parsed: Record<string, unknown>): string {
  for (const key of ['message', 'msg', 'error', 'details']) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * Map an upstream failure onto a kind.
 *
 * Order matters: the gateway answers most failures with HTTP 400 plus a business
 * code, so the code and message have to be read before the status decides.
 */
export function classifyUpstreamError(status: number, body: string): RaccoonErrorKind {
  let code = ''
  let message = body
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const document = parsed as Record<string, unknown>
      code = codeOf(document)
      message = `${messageOf(document)} ${body}`
    }
  } catch {
    // A non-JSON body is judged on status alone.
  }
  const lower = message.toLowerCase()
  if (SESSION_DEAD_CODES.has(code)) return 'session_dead'
  if (CREDIT_CODES.has(code) || CREDIT_PHRASES.some(phrase => lower.includes(phrase.toLowerCase()))) return 'hard_credit'
  if (status === 429 || RATE_PHRASES.some(phrase => lower.includes(phrase.toLowerCase()))) return 'soft_rate'
  if (status === 401 || status === 403) return 'session_dead'
  if (status === 404) return 'not_found'
  if (status === 0 || status >= 500) return 'server'
  return 'client'
}

/** A failed upstream call, with the kind the shim should re-expose. */
export interface RaccoonUpstreamFailure {
  ok: false
  status: number
  kind: RaccoonErrorKind
  message: string
}

/** A successful streaming call: the caller pipes the body through untouched. */
export interface RaccoonUpstreamStream {
  ok: true
  status: number
  body: ReadableStream<Uint8Array>
  contentType: string
}

/** One reasoning-effort probe attempt's observable outcome. */
export interface RaccoonProbeAttempt {
  status: number
  /** Whether the upstream accepted the parameter value at all. */
  accepted: boolean
  /** Whether any SSE data arrived, which is the only proof it was used. */
  streamed: boolean
  /** Business code from a rejected body, for the non-validating test. */
  errorCode?: string
  /** Rejection text, which is where `params_invalid_error` actually appears. */
  message?: string
}

/** Options for the probe's single request. */
export interface RaccoonProbeOptions {
  effort?: string
  /** Whether the account is billed through an organization route. */
  systemPrefix?: string
  maxTokens?: number
  signal?: AbortSignal
}

/** Constructor options. */
export interface RaccoonUpstreamOptions {
  variant: RaccoonVariant
  /** Identity headers; resolved lazily so a late app install is still picked up. */
  identity?: () => RaccoonClientIdentity
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch
  /** Non-streaming request timeout; streaming is never timed out this way. */
  timeoutMs?: number
  /**
   * How long a streaming call may spend before the gateway sends response
   * headers.
   *
   * Measured on this gateway (2026-10-29): first byte is normally 1–2 s, but a
   * stalled call can sit for 60 s with nothing on the wire. The timer is cleared
   * as soon as headers arrive, so a long *answer* is never cut off — only a
   * gateway that has not started answering at all is.
   */
  streamFirstByteTimeoutMs?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read one SSE stream far enough to know whether it started.
 *
 * The probe must not wait for a full answer — that is what costs credit — so it
 * resolves on the first `data:` line and aborts the request immediately after.
 */
async function readFirstEvent(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined): Promise<{ streamed: boolean, body: string }> {
  const reader = body.getReader()
  const chunks: string[] = []
  try {
    const read = await Promise.race([
      reader.read(),
      new Promise<null>((resolveRead, rejectRead) => {
        const abort = (): void => rejectRead(new Error('aborted'))
        if (signal?.aborted === true) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      }),
    ])
    if (read === null) return { streamed: false, body: '' }
    const text = new TextDecoder().decode(read.value ?? new Uint8Array())
    chunks.push(text)
    return { streamed: /data:\s*(\[DONE\]|.{1,})/u.test(chunks.join('')), body: chunks.join('').slice(0, 4096) }
  } catch {
    return { streamed: false, body: chunks.join('').slice(0, 4096) }
  } finally {
    // Cancel rather than drain: the upstream bills for what it generates.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** The 小浣熊 gateway client. */
export class RaccoonUpstreamClient {
  private readonly variant: RaccoonVariant
  private readonly identity: () => RaccoonClientIdentity
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly streamFirstByteTimeoutMs: number

  constructor(options: RaccoonUpstreamOptions) {
    this.variant = options.variant
    this.identity = options.identity ?? (() => ({ platform: 'desktop' }))
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.streamFirstByteTimeoutMs = options.streamFirstByteTimeoutMs ?? 60_000
  }

  /** LLM gateway base, without a trailing slash. */
  get llmBase(): string {
    return this.variant.llmBase.replace(/\/+$/u, '')
  }

  private get authBase(): string {
    return `${this.variant.siteOrigin.replace(/\/+$/u, '')}/api/web/auth/v1`
  }

  private get pointsBase(): string {
    return `${this.variant.siteOrigin.replace(/\/+$/u, '')}/api/web/points/v1`
  }

  /**
   * Headers every authenticated call carries.
   *
   * The identity headers are omitted rather than sent empty: the web client
   * only adds them when it could parse its own user agent, and an empty
   * `X-Client-Device-ID` is a different statement from no header.
   */
  private headers(accessToken: string, identity = this.identity()): Record<string, string> {
    const out: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Org-Code': '',
      'X-Raccoon-Language': 'zh',
      'X-Client-Platform': identity.platform,
    }
    if (identity.version !== undefined) out['X-Client-Version'] = identity.version
    if (identity.deviceId !== undefined) out['X-Client-Device-ID'] = identity.deviceId
    return out
  }

  /** POST with a timeout that never fires once streaming starts. */
  private async request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    if (timeoutMs <= 0) return await this.fetchImpl(url, init)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    const caller = init.signal
    const relay = (): void => controller.abort(caller?.reason ?? new Error('aborted'))
    if (caller !== null && caller !== undefined) {
      if (caller.aborted) relay()
      else caller.addEventListener('abort', relay, { once: true })
    }
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Read the whole response body, because `envelope` has to `JSON.parse` it.
   *
   * This used to return `(await response.text()).slice(0, 4096)`. That cap was
   * survivable while the gateway's `model_catalog` document fitted in 4 KiB, but
   * the roster is account-dependent and grows: once it crossed 4096 characters
   * the slice cut the document mid-string, `JSON.parse` threw, `envelope`
   * reported a failure, and the plugin silently degraded to the built-in
   * fallback roster — new models never appeared, and the card showed only the
   * unhelpful `[object Object]`.
   *
   * Bounding belongs at the sites that *display* a body (`failure`, or the
   * `slice(0, 512)` when a message is carried into an error), not here, where
   * the value is input to a parser.
   */
  private static async textOf(response: Response): Promise<string> {
    try {
      return await response.text()
    } catch {
      return ''
    }
  }

  /**
   * Unwrap the `{code, message, data}` envelope.
   *
   * A non-zero code is a failure even on HTTP 200, and the message is kept
   * because its business phrase is how `classifyUpstreamError` recognizes credit
   * exhaustion. A body with no envelope at all is returned as-is, since that is
   * how the gateway answers some endpoints.
   */
  private static async envelope(response: Response): Promise<{ ok: true, data: unknown } | { ok: false, status: number, kind: RaccoonErrorKind, message: string }> {
    const text = await RaccoonUpstreamClient.textOf(response)
    if (!response.ok) {
      return { ok: false, status: response.status, kind: classifyUpstreamError(response.status, text), message: text }
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const document = parsed as Record<string, unknown>
        const code = codeOf(document)
        if (code !== '' && code !== '0') {
          return { ok: false, status: response.status, kind: classifyUpstreamError(200, text), message: text }
        }
        return { ok: true, data: 'data' in document ? document['data'] : document }
      }
      return { ok: true, data: parsed }
    } catch {
      return { ok: false, status: response.status, kind: 'client', message: text }
    }
  }

  private static failure(response: { ok: false, status: number, kind: RaccoonErrorKind, message: string }): RaccoonUpstreamFailure {
    return response
  }

  /**
   * Exchange a refresh token for a fresh pair.
   *
   * Deliberately unauthenticated: the refresh token is the credential, and the
   * gateway rejects a request that also carries an `Authorization` header.
   * The desktop app's failure text is reproduced here so a caller that sees the
   * error knows which leg broke.
   */
  async refresh(refreshToken: string): Promise<RaccoonRefreshOutcome> {
    if (refreshToken === '') throw new Error('raccoon: no refresh token to exchange')
    let response: Response
    try {
      response = await this.request(`${this.authBase}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }, this.timeoutMs)
    } catch (error: unknown) {
      throw new Error(`raccoon: refresh request failed (${errorMessage(error)})`)
    }
    const parsed = await RaccoonUpstreamClient.envelope(response)
    if (parsed.ok === false) {
      throw new Error(`raccoon: refresh rejected ${parsed.kind} (HTTP ${parsed.status}): ${parsed.message.slice(0, 200)}`)
    }
    const data: unknown = parsed.data
    if (typeof data !== 'object' || data === null) throw new Error('raccoon: refresh returned no data')
    const fields = data as Record<string, unknown>
    const accessToken = typeof fields['access_token'] === 'string' ? fields['access_token'] : ''
    if (accessToken === '') throw new Error('raccoon: refresh response carried no access_token')
    const nextRefresh = typeof fields['refresh_token'] === 'string' && fields['refresh_token'] !== ''
      ? fields['refresh_token']
      : undefined
    return { accessToken, ...(nextRefresh === undefined ? {} : { refreshToken: nextRefresh }) }
  }

  /** Fetch and parse the model catalog. */
  async fetchCatalog(accessToken: string, signal?: AbortSignal): Promise<RaccoonCatalogDocument> {
    const response = await this.request(`${this.llmBase}/model_catalog`, {
      method: 'GET',
      headers: this.headers(accessToken),
      ...(signal === undefined ? {} : { signal }),
    }, this.timeoutMs)
    const parsed = await RaccoonUpstreamClient.envelope(response)
    if (parsed.ok === false) throw RaccoonUpstreamClient.failure(parsed)
    const fromParser = parseCatalogDocument(parsed.data)
    if (fromParser === undefined) throw new Error('raccoon: model_catalog resolved to an empty list')
    return fromParser
  }

  /** Remaining credit and plan label, best effort. */
  async fetchBalance(accessToken: string, signal?: AbortSignal): Promise<RaccoonWebPoints> {
    const response = await this.request(`${this.pointsBase}/balance`, {
      method: 'GET',
      headers: this.headers(accessToken),
      ...(signal === undefined ? {} : { signal }),
    }, this.timeoutMs)
    const parsed = await RaccoonUpstreamClient.envelope(response)
    if (parsed.ok === false) throw RaccoonUpstreamClient.failure(parsed)
    const data: unknown = parsed.data
    if (typeof data !== 'object' || data === null) return {}
    const fields = data as Record<string, unknown>
    const total = firstNumber(fields, ['total', 'available', 'available_points', 'balance', 'remain', 'points', 'remain_points'])
    const plan = firstString(fields, ['plan', 'plan_name', 'package', 'package_name', 'type'])
    const note = firstString(fields, ['note', 'description', 'message'])
    return {
      ...(total === undefined ? {} : { total }),
      ...(plan === undefined ? {} : { plan }),
      ...(note === undefined ? {} : { note }),
    }
  }

  /**
   * Stream one chat completion.
   *
   * The body is passed through as the caller built it: this gateway is the same
   * OpenAI-compatible endpoint the desktop app's own agent uses, so rewriting
   * fields here would only risk diverging from what it actually accepts. The
   * response body is returned unread so the shim can pipe it byte for byte.
   *
   * Only the wait *before* headers is bounded; once the gateway has started
   * answering, the stream is left alone so a slow or long answer is never cut
   * short.
   */
  async chatStream(accessToken: string, body: unknown, signal?: AbortSignal): Promise<RaccoonUpstreamStream | RaccoonUpstreamFailure> {
    let response: Response
    try {
      response = await this.request(`${this.llmBase}/chat/completions`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      }, this.streamFirstByteTimeoutMs)
    } catch (error: unknown) {
      // A transport failure is reported as a gateway problem, not a client one:
      // pi-ai should retry it rather than surface it as a bad request.
      return { ok: false, status: 0, kind: 'server', message: errorMessage(error) }
    }
    if (!response.ok || response.body === null) {
      const text = await RaccoonUpstreamClient.textOf(response)
      return {
        ok: false,
        status: response.status,
        kind: classifyUpstreamError(response.status === 0 ? 502 : response.status, text),
        message: response.body === null && response.ok ? 'raccoon: upstream returned an empty body' : text,
      }
    }
    return { ok: true, status: response.status, body: response.body, contentType: response.headers.get('content-type') ?? 'text/event-stream' }
  }

  /**
   * Spend the smallest possible request to learn whether one parameter value is
   * honored.
   *
   * `max_tokens` is kept at the gateway's floor and the reader hangs up on the
   * first SSE event, because a probe that waits for a full answer is a paid
   * completion wearing a lab coat.
   */
  async probeEffort(accessToken: string, model: string, options: RaccoonProbeOptions = {}): Promise<RaccoonProbeAttempt> {
    const messages: Record<string, unknown>[] = []
    if (options.systemPrefix !== undefined && options.systemPrefix !== '') messages.push({ role: 'system', content: options.systemPrefix })
    messages.push({ role: 'user', content: 'ping' })
    const payload: Record<string, unknown> = {
      model,
      stream: true,
      messages,
      max_tokens: options.maxTokens ?? 1,
    }
    if (options.effort !== undefined) payload['reasoning_effort'] = options.effort
    let response: Response
    try {
      response = await this.request(`${this.llmBase}/chat/completions`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify(payload),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, 0)
    } catch (error: unknown) {
      // Transport-level failure: nothing was learned about the parameter, so the
      // sweep must treat this as undecided rather than as a refusal.
      void errorMessage(error)
      return { status: 0, accepted: false, streamed: false }
    }
    const text = response.ok && response.body !== null ? '' : await RaccoonUpstreamClient.textOf(response)
    if (!response.ok || response.body === null) {
      const code = probeErrorCodeOf(text)
      return {
        status: response.status,
        accepted: false,
        streamed: false,
        ...(code === undefined ? {} : { errorCode: code }),
        ...(text === '' ? {} : { message: text.slice(0, 512) }),
      }
    }
    const first = await readFirstEvent(response.body, options.signal)
    const code = probeErrorCodeOf(first.body)
    return {
      status: response.status,
      accepted: first.streamed,
      streamed: first.streamed,
      ...(code === undefined ? {} : { errorCode: code }),
      ...(first.body === '' ? {} : { message: first.body.slice(0, 512) }),
    }
  }
}

/** Parse a business code out of a rejected probe body. */
function probeErrorCodeOf(body: string): string | undefined {
  if (body === '') return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const code = (parsed as Record<string, unknown>)['code']
    if (typeof code === 'number' && Number.isFinite(code)) return String(code)
    if (typeof code === 'string' && code !== '') return code
    return undefined
  } catch {
    return undefined
  }
}

function firstNumber(fields: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = fields[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function firstString(fields: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Envelope data may already be the document, or its `data` member. */
function parseCatalogDocument(document: unknown): RaccoonCatalogDocument | undefined {
  return parseModelCatalog(document)
}
