/**
 * Loopback OpenAI-compatible façade in front of the 小浣熊 gateway.
 *
 * pi-ai and the harness streaming pipeline are kept entirely unmodified: they
 * talk OpenAI-compatible HTTP to a server bound to 127.0.0.1 on a random port,
 * and everything that is *not* OpenAI-compatible about the upstream — resolving
 * and refreshing the desktop credential, the identity headers, the error
 * taxonomy — happens between this façade and the gateway. Two consequences are
 * load-bearing:
 *
 * - the real access token never crosses into pi-ai. What pi-ai sends as its
 *   `Authorization` value is this process's random shared secret, which the shim
 *   checks in constant time before it will forward anything.
 * - the upstream SSE body is piped through byte for byte, so usage accounting,
 *   tool-call assembly and reasoning deltas are parsed by the same code the
 *   harness uses for every other provider.
 *
 * @module dsh-raccoon-connect/shim
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { bearerOf, constantTimeEquals, isLoopbackHost, isLoopbackOrigin } from './net-guard.ts'
import { KIND_STATUS, type RaccoonUpstreamClient, type RaccoonUpstreamFailure, type RaccoonUpstreamStream } from './upstream.ts'
import type { RaccoonCatalog } from './catalog.ts'

/** Largest request body the shim will buffer. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/** Hardening knobs, overridable only for tests. */
export interface RaccoonShimOptions {
  /** Resolves an access token, refreshing if needed. May throw. */
  accessToken: () => Promise<string>
  /** Upstream client used for the forwarded call. */
  upstream: Pick<RaccoonUpstreamClient, 'chatStream'>
  /** Serves `/v1/models`; may be absent until the first catalog lands. */
  catalog?: () => RaccoonCatalog
}

/** A started shim. */
export interface RaccoonShim {
  /** Base URL pi-ai should be pointed at, without the `/v1` suffix. */
  baseUrl(): string
  /** The per-process bearer secret the caller must present. */
  token(): string
  /** Model list in OpenAI's `/v1/models` shape. */
  models(): { object: string, data: { id: string, object: string, owned_by?: string }[] }
  stop(): Promise<void>
  /** Port actually bound; diagnostics only. */
  port(): number
}

function writeJson(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** An OpenAI-shaped error document, so pi-ai classifies it the way we intend. */
function openAiError(kind: string, message: string): unknown {
  return { error: { message, type: kind, code: kind } }
}

/**
 * Start the shim.
 *
 * The server is created and bound here rather than lazily: `baseUrl()` is read
 * while the provider is being registered, and a port that only exists after the
 * first request cannot be advertised to pi-ai.
 */
export async function startRaccoonShim(options: RaccoonShimOptions): Promise<RaccoonShim> {
  const secret = randomBytes(24).toString('hex')
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      // Never leak a stack as a 500: the caller's error surface is OpenAI-shaped.
      writeJson(res, 500, openAiError('server', error instanceof Error ? error.message : String(error)))
    })
  })

  async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (!isLoopbackHost(req.headers.host)) {
      writeJson(res, 403, openAiError('client', 'raccoon shim: non-loopback Host rejected'))
      return
    }
    if (!isLoopbackOrigin(req.headers.origin)) {
      writeJson(res, 403, openAiError('client', 'raccoon shim: foreign Origin rejected'))
      return
    }
    if (path === '/healthz') {
      writeJson(res, 200, { ok: true })
      return
    }
    if (!constantTimeEquals(bearerOf(req.headers.authorization), secret)) {
      writeJson(res, 401, openAiError('client', 'raccoon shim: shared secret missing or wrong'))
      return
    }
    if (path === '/v1/models' && req.method === 'GET') {
      writeJson(res, 200, shim.models())
      return
    }
    if (path !== '/v1/chat/completions' || req.method !== 'POST') {
      writeJson(res, 404, openAiError('not_found', `raccoon shim: no route for ${req.method} ${path}`))
      return
    }
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.includes('application/json')) {
      writeJson(res, 415, openAiError('client', 'raccoon shim: expected an JSON request body'))
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(await readBody(req))
    } catch {
      writeJson(res, 400, openAiError('client', 'raccoon shim: request body is not JSON'))
      return
    }
    let accessToken: string
    try {
      accessToken = await options.accessToken()
    } catch (error: unknown) {
      // Credential failures surface as an authentication error, which pi-ai
      // reports without retrying into a login wall.
      writeJson(res, KIND_STATUS.session_dead, openAiError('session_dead', error instanceof Error ? error.message : String(error)))
      return
    }
    const outcome = await options.upstream.chatStream(accessToken, raw, reqForSignal(req))
    if (outcome.ok === false) {
      const failure: RaccoonUpstreamFailure = outcome
      writeJson(res, KIND_STATUS[failure.kind], openAiError(failure.kind, failure.message))
      return
    }
    const stream: RaccoonUpstreamStream = outcome
    res.writeHead(stream.status, {
      'content-type': stream.contentType,
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    await pipeThrough(stream, res)
  }

  function readBody(req: import('node:http').IncomingMessage): Promise<string> {
    return new Promise((resolveBody, rejectBody) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          rejectBody(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
      req.on('error', rejectBody)
    })
  }

  /**
   * Copy the upstream SSE body to the response.
   *
   * A mid-flight upstream failure still has to terminate the stream, or the
   * caller waits for an end that already happened; `[DONE]` is the terminator an
   * OpenAI client understands.
   */
  async function pipeThrough(stream: RaccoonUpstreamStream, res: import('node:http').ServerResponse): Promise<void> {
    let sawDone = false
    try {
      const source = Readable.fromWeb(stream.body as import('node:stream/web').ReadableStream)
      source.on('data', (chunk: Buffer) => {
        if (chunk.includes('[DONE]')) sawDone = true
      })
      await new Promise<void>((resolvePipe, rejectPipe) => {
        source.once('error', rejectPipe)
        res.once('close', () => {
          source.destroy()
          resolvePipe()
        })
        source.pipe(res)
      })
    } catch {
      // Fall through to the terminator below.
    }
    if (!res.writableEnded) {
      if (!sawDone) res.end('data: [DONE]\n\n')
      else res.end()
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('raccoon shim: failed to bind a loopback port')
  const port = address.port

  const shim: RaccoonShim = {
    baseUrl: () => `http://127.0.0.1:${port}`,
    token: () => secret,
    port: () => port,
    models: () => ({
      object: 'list',
      data: (options.catalog?.().current() ?? []).map(model => ({ id: model.id, object: 'model' as const })),
    }),
    stop: () => new Promise<void>(resolveStop => {
      server.close(() => resolveStop())
      // Idle keep-alive sockets would otherwise hold close() open forever.
      server.closeIdleConnections?.()
    }),
  }
  return shim
}

/** Abort signal tied to the client hanging up, so upstream spend stops with it. */
function reqForSignal(req: import('node:http').IncomingMessage): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && 'abort' in AbortSignal) {
    const controller = new AbortController()
    req.once('aborted', () => controller.abort(new Error('client disconnected')))
    req.once('close', () => controller.abort(new Error('client disconnected')))
    return controller.signal
  }
  return undefined
}
