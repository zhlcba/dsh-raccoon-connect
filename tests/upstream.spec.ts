import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyUpstreamError, KIND_STATUS, RaccoonUpstreamClient } from '../src/upstream.ts'
import { RACCOON_PRIMARY } from '../src/variants.ts'
import type { RaccoonClientIdentity } from '../src/client-identity.ts'

/**
 * The gateway client: error taxonomy, envelope discipline, and the
 * spend-as-little-as-possible probe request.
 *
 * Pinned invariants:
 * - business codes outrank HTTP status: the gateway answers most failures with
 *   HTTP 400 + a code, and 200003/200822 mean the session is dead no matter
 *   what the status says;
 * - a non-zero envelope code is a failure even on HTTP 200;
 * - refresh is deliberately unauthenticated (the refresh token *is* the
 *   credential and the gateway rejects a request that also carries a bearer);
 * - identity headers are omitted, not sent empty, when the client cannot
 *   name itself;
 * - `chatStream` hands the raw byte stream through untouched and reports
 *   transport failures as a retryable gateway problem (status 0), never as a
 *   client error;
 * - `probeEffort` sends the smallest request it can and hangs up after the
 *   first SSE event, because a probe that waits for a full answer spends
 *   credit on an answer it does not need.
 *
 * No request leaves the process: every call runs through a stubbed
 * `fetchImpl`, and the SSE bodies are real `Response`/`ReadableStream`
 * objects so the streaming legs exercise the actual reader code.
 */

/** One SSE chunk stream; the pull counter proves the reader stopped early. */
function sseResponse(chunks: readonly string[], init?: { status?: number, headers?: Record<string, string> }): { response: Response, pulls: () => number, cancelled: () => boolean } {
  let pulls = 0
  let cancelled = false
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[pulls]!))
      pulls += 1
    },
    cancel() { cancelled = true },
  })
  const response = new Response(body, {
    status: init?.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...(init?.headers ?? {}) },
  })
  return { response, pulls: () => pulls, cancelled: () => cancelled }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Call { url: string, init: RequestInit | undefined }

let calls: Call[]
let nextResponse: (() => Response | Promise<Response>) | undefined

async function baseFetch(input: unknown, init?: RequestInit): Promise<Response> {
  calls.push({ url: String(input), init })
  const reply = nextResponse?.() ?? jsonResponse({ code: 0, data: {} })
  if (reply instanceof Promise) return await reply
  return reply
}

const fetchStub = vi.fn(baseFetch)

function transportFails(error: Error): void {
  fetchStub.mockImplementation(async () => { throw error })
}

function makeClient(identity?: () => RaccoonClientIdentity): RaccoonUpstreamClient {
  return new RaccoonUpstreamClient({
    variant: RACCOON_PRIMARY,
    ...(identity === undefined ? {} : { identity }),
    fetchImpl: fetchStub as unknown as typeof fetch,
  })
}

function headersOf(index: number): Record<string, string> {
  return { ...(calls[index]!.init?.headers as Record<string, string> | undefined) }
}

beforeEach(() => {
  calls = []
  nextResponse = undefined
  fetchStub.mockReset()
  fetchStub.mockImplementation(baseFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('classifyUpstreamError', () => {
  it('reads the session-dead business codes before the status does', () => {
    expect(classifyUpstreamError(400, JSON.stringify({ code: 200003, message: 'login expired' }))).toBe('session_dead')
    expect(classifyUpstreamError(200, JSON.stringify({ code: 200822, message: 'refresh token reused' }))).toBe('session_dead')
    expect(classifyUpstreamError(401, 'bare text')).toBe('session_dead')
    expect(classifyUpstreamError(403, 'bare text')).toBe('session_dead')
  })

  it('recognizes credit exhaustion by code and by every upstream phrase, beating the 429 default', () => {
    expect(classifyUpstreamError(400, JSON.stringify({ code: 200402 }))).toBe('hard_credit')
    expect(classifyUpstreamError(400, JSON.stringify({ code: 200429 }))).toBe('hard_credit')
    expect(classifyUpstreamError(400, JSON.stringify({ code: 100402 }))).toBe('hard_credit')
    for (const phrase of ['积分不足', '余额不足', '点数不足', 'quota exceeded', 'insufficient balance', 'insufficient points', 'payment required']) {
      expect(classifyUpstreamError(429, phrase)).toBe('hard_credit')
    }
  })

  it('calls rate limiting soft and everything else by status band', () => {
    expect(classifyUpstreamError(429, 'too slow')).toBe('soft_rate')
    expect(classifyUpstreamError(400, JSON.stringify({ message: '请求过于频繁' }))).toBe('soft_rate')
    expect(classifyUpstreamError(404, 'no such model')).toBe('not_found')
    expect(classifyUpstreamError(500, 'boom')).toBe('server')
    expect(classifyUpstreamError(503, '<html>')).toBe('server')
    expect(classifyUpstreamError(0, 'connect econnreset')).toBe('server')
    expect(classifyUpstreamError(400, 'bad parameter')).toBe('client')
    expect(classifyUpstreamError(200, 'unparsable, non-zero-less body')).toBe('client')
  })

  it('maps every kind back onto the HTTP status an OpenAI client already interprets right', () => {
    expect(KIND_STATUS).toEqual({
      hard_credit: 402,
      soft_rate: 429,
      session_dead: 401,
      not_found: 502,
      server: 502,
      client: 400,
    })
  })
})

describe('refresh', () => {
  it('posts the bare refresh token to the auth site with NO Authorization header', async () => {
    nextResponse = () => jsonResponse({ code: 0, data: { access_token: 'AT', refresh_token: 'RT' } })
    const outcome = await makeClient().refresh('R1')
    expect(outcome).toEqual({ accessToken: 'AT', refreshToken: 'RT' })
    const [call] = calls
    expect(call?.url).toBe('https://xiaohuanxiong.com/api/web/auth/v1/refresh')
    expect(call?.init?.method).toBe('POST')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ refresh_token: 'R1' })
    const headers = headersOf(0)
    expect(headers['Authorization']).toBeUndefined()
    expect(headers['X-Org-Code']).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('keeps the old refresh token when the response rotates only the access token', async () => {
    nextResponse = () => jsonResponse({ code: 0, data: { access_token: 'AT', refresh_token: '' } })
    expect(await makeClient().refresh('R1')).toEqual({ accessToken: 'AT' })
  })

  it('fails on a non-zero envelope code even on HTTP 200, naming the kind', async () => {
    nextResponse = () => jsonResponse({ code: 200822, message: 'refresh_conflict' })
    await expect(makeClient().refresh('R1')).rejects.toThrow(/refresh rejected session_dead \(HTTP 200\)/u)
  })

  it('refuses to burn an empty token and wraps transport failures without leaking them raw', async () => {
    await expect(makeClient().refresh('')).rejects.toThrow('raccoon: no refresh token to exchange')
    transportFails(new TypeError('fetch failed'))
    await expect(makeClient().refresh('R1')).rejects.toThrow(/refresh request failed \(fetch failed\)/u)
  })

  it('rejects a refresh response with no usable access_token', async () => {
    nextResponse = () => jsonResponse({ code: 0, data: {} })
    await expect(makeClient().refresh('R1')).rejects.toThrow('raccoon: refresh response carried no access_token')
    nextResponse = () => jsonResponse('not json')
    await expect(makeClient().refresh('R1')).rejects.toThrow(/refresh rejected client/u)
  })
})

describe('fetchCatalog', () => {
  const catalogBody = {
    code: 0,
    data: {
      default_model: 'glm',
      categories: [{ type: 'chat', models: [{ name: 'glm', description: 'GLM', params: { context_window: 1000 } }] }],
    },
  }

  it('GETs model_catalog off the LLM base with the bearer and identity headers', async () => {
    nextResponse = () => jsonResponse(catalogBody)
    const document = await makeClient(() => ({ platform: 'desktop', version: '1.2.3', deviceId: 'dev-1' }))
      .fetchCatalog('AT')
    expect(document.defaultModelId).toBe('glm')
    expect(calls[0]!.url).toBe('https://xiaohuanxiong.com/api/web/llm/v2/model_catalog')
    expect(calls[0]!.init?.method).toBe('GET')
    const headers = headersOf(0)
    expect(headers['Authorization']).toBe('Bearer AT')
    expect(headers['X-Org-Code']).toBe('')
    expect(headers['X-Raccoon-Language']).toBe('zh')
    expect(headers['X-Client-Platform']).toBe('desktop')
    expect(headers['X-Client-Version']).toBe('1.2.3')
    expect(headers['X-Client-Device-ID']).toBe('dev-1')
  })

  it('omits identity headers it cannot name instead of sending them empty', async () => {
    nextResponse = () => jsonResponse(catalogBody)
    await makeClient(() => ({ platform: 'web' })).fetchCatalog('AT')
    const headers = headersOf(0)
    expect(headers['X-Client-Platform']).toBe('web')
    expect('X-Client-Version' in headers).toBe(false)
    expect('X-Client-Device-ID' in headers).toBe(false)
  })

  it('treats a non-zero envelope code on HTTP 200 as a failure and keeps the classified kind', async () => {
    nextResponse = () => jsonResponse({ code: 200003, message: 'login expired' })
    await expect(makeClient().fetchCatalog('AT')).rejects.toMatchObject({
      ok: false,
      status: 200,
      kind: 'session_dead',
    })
  })

  it('fails loudly on a catalog that resolves to nothing usable', async () => {
    nextResponse = () => jsonResponse({ code: 0, data: { categories: [{ type: 'chat', models: [] }] } })
    await expect(makeClient().fetchCatalog('AT')).rejects.toThrow(/resolved to an empty list/u)
  })
})

describe('fetchBalance', () => {
  it('reads the first usable number/string from the documented field spellings', async () => {
    nextResponse = () => jsonResponse({ code: 0, data: { available_points: 1250, package_name: 'Pro', description: 'plan renews monthly' } })
    await expect(makeClient().fetchBalance('AT')).resolves.toEqual({ total: 1250, plan: 'Pro', note: 'plan renews monthly' })
    expect(calls[0]!.url).toBe('https://xiaohuanxiong.com/api/web/points/v1/balance')
  })

  it('surfaces a credit-code failure as a rejected call, not a silent zero', async () => {
    nextResponse = () => jsonResponse({ code: 200402, message: '积分不足' })
    await expect(makeClient().fetchBalance('AT')).rejects.toMatchObject({ kind: 'hard_credit' })
  })
})

describe('chatStream', () => {
  it('passes the SSE bytes through untouched on success, carrying content-type and status', async () => {
    const upstream = sseResponse(['data: {"choices":[]}\n\n', 'data: [DONE]\n\n'])
    nextResponse = () => upstream.response
    const outcome = await makeClient().chatStream('AT', { model: 'glm', messages: [] })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const reader = outcome.body.getReader()
    const chunks: string[] = []
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value))
    }
    expect(chunks.join('')).toBe('data: {"choices":[]}\n\ndata: [DONE]\n\n')
    expect(outcome.contentType).toBe('text/event-stream')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ model: 'glm', messages: [] })
    expect(headersOf(0)['Authorization']).toBe('Bearer AT')
  })

  it('reports a non-2xx upstream as an OpenAI-shaped failure with the classified kind and status', async () => {
    nextResponse = () => jsonResponse({ code: 200429, message: '点数不足' }, 429)
    const outcome = await makeClient().chatStream('AT', { model: 'glm', messages: [] })
    expect(outcome).toMatchObject({ ok: false, status: 429, kind: 'hard_credit' })
  })

  it('maps a transport throw to a retryable gateway failure: status 0, kind server', async () => {
    transportFails(new TypeError('fetch failed'))
    const outcome = await makeClient().chatStream('AT', {})
    expect(outcome).toMatchObject({ ok: false, status: 0, kind: 'server' })
  })

  it('fails an ok response whose body is null instead of piping nothing', async () => {
    nextResponse = () => new Response(null, { status: 200 })
    const outcome = await makeClient().chatStream('AT', {})
    expect(outcome).toMatchObject({ ok: false, status: 200, message: 'raccoon: upstream returned an empty body' })
  })
})

describe('probeEffort', () => {
  it('sends max_tokens:1, stream:true, one ping, and reasoning_effort only when given', async () => {
    nextResponse = () => sseResponse(['data: {"x":1}\n\n']).response
    const client = makeClient()
    await client.probeEffort('AT', 'glm')
    const bare = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(bare).toEqual({ model: 'glm', stream: true, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
    expect('reasoning_effort' in bare).toBe(false)

    await client.probeEffort('AT', 'glm', { effort: 'high', systemPrefix: 'ctx', maxTokens: 4 })
    const withEffort = JSON.parse(String(calls[1]!.init?.body)) as Record<string, unknown>
    expect(withEffort['reasoning_effort']).toBe('high')
    expect(withEffort['max_tokens']).toBe(4)
    expect(withEffort['messages']).toEqual([{ role: 'system', content: 'ctx' }, { role: 'user', content: 'ping' }])
  })

  it('hangs up after the first SSE event instead of draining the paid completion', async () => {
    const stream = sseResponse(Array.from({ length: 50 }, (_, i) => `data: {"chunk":${i}}\n\n`))
    nextResponse = () => stream.response
    const attempt = await makeClient().probeEffort('AT', 'glm', { effort: 'low' })
    expect(attempt.accepted).toBe(true)
    expect(attempt.streamed).toBe(true)
    expect(attempt.status).toBe(200)
    // One or two pulls (undici reads a chunk ahead), then cancel — not the
    // whole paid completion drained.
    expect(stream.pulls()).toBeLessThan(5)
    expect(stream.cancelled()).toBe(true)
  })

  it('reports a decisive refusal with its business code and message, and nothing streamed', async () => {
    nextResponse = () => jsonResponse({ code: 100002, message: 'params_invalid_error: reasoning_effort' }, 400)
    const attempt = await makeClient().probeEffort('AT', 'glm', { effort: 'banana' })
    expect(attempt).toMatchObject({ status: 400, accepted: false, streamed: false, errorCode: '100002' })
    expect(attempt.message).toContain('params_invalid_error')
  })

  it('treats a transport failure as undecided silence: status 0, accepted false', async () => {
    transportFails(new TypeError('offline'))
    await expect(makeClient().probeEffort('AT', 'glm')).resolves.toEqual({ status: 0, accepted: false, streamed: false })
  })

  it('does not claim acceptance for a 200 that never produces an SSE data event', async () => {
    nextResponse = () => sseResponse([]).response
    const attempt = await makeClient().probeEffort('AT', 'glm', { effort: 'low' })
    expect(attempt).toMatchObject({ status: 200, accepted: false, streamed: false })
  })
})
