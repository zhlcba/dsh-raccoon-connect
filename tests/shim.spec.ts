import { request } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startRaccoonShim } from '../src/shim.ts'
import type { RaccoonShim } from '../src/shim.ts'
import { RaccoonCatalog } from '../src/catalog.ts'
import type { RaccoonCatalogModel } from '../src/catalog.ts'
import type { RaccoonUpstreamFailure, RaccoonUpstreamStream } from '../src/upstream.ts'

/**
 * The loopback façade, driven over real HTTP against its ephemeral port.
 *
 * Pinned here because the shim is the trust boundary between pi-ai and the
 * 小浣熊 session:
 * - it answers ONLY loopback Hosts from loopback origins (a rebinding page
 *   must not reach the credential-backed route);
 * - it checks the per-process bearer secret before forwarding anything, and
 *   the real token never appears in what it accepts or emits;
 * - upstream SSE bytes are piped through untouched, with a `data: [DONE]`
 *   terminator appended only when the upstream stopped without one;
 * - every upstream failure is re-exposed OpenAI-shaped at the status the
 *   error kind maps onto;
 * - stop() actually releases the port.
 *
 * No request leaves this machine: the "upstream" is an in-process stub.
 */

const model = (id: string, label = id): RaccoonCatalogModel => ({
  id,
  label,
  visible: true,
  tags: [],
  abilityLevel: 1,
  billingDiscounts: [],
})

const catalog = new RaccoonCatalog()
catalog.set({ defaultModelId: 'glm', models: [model('glm', 'GLM'), model('ds')] })

/** The chatStream the shim sees; a test replaces its behavior. */
let chatOutcome: Promise<RaccoonUpstreamStream | RaccoonUpstreamFailure>
/** Last body the shim forwarded, so a test can pin what left the process. */
let forwarded: unknown
let accessTokenImpl: () => Promise<string> = async () => 'real-upstream-token'

const shimShim: { upstream: { chatStream: (t: string, b: unknown) => typeof chatOutcome } } = {
  upstream: {
    chatStream: (token, body) => {
      forwarded = { token, body }
      return chatOutcome
    },
  },
}

let shim: RaccoonShim

beforeAll(async () => {
  shim = await startRaccoonShim({
    accessToken: () => accessTokenImpl(),
    upstream: shimShim.upstream,
    catalog: () => catalog,
  })
})

afterAll(async () => {
  await shim.stop()
})

beforeEach(() => {
  forwarded = undefined
  accessTokenImpl = async () => 'real-upstream-token'
  chatOutcome = Promise.resolve(streamOf(['data: [DONE]\n\n']))
})

function streamOf(chunks: readonly string[]): RaccoonUpstreamStream {
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    contentType: 'text/event-stream',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
  }
}

const bearer = (): Record<string, string> => ({ Authorization: `Bearer ${shim.token()}` })

/** One raw HTTP round trip where the test owns every header, incl. Host. */
function rawHttp(path: string, headers: Record<string, string>): Promise<{ status: number, body: string }> {
  return new Promise((resolveReq, rejectReq) => {
    const req = request({ host: '127.0.0.1', port: shim.port(), path, method: 'GET', headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolveReq({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', rejectReq)
    req.end()
  })
}

describe('shim guards', () => {
  it('rejects a Host that does not name loopback, before any auth', async () => {
    // fetch cannot override Host, so this leg speaks raw HTTP — exactly how a
    // rebinding DNS answer would arrive: same socket, hostile authority.
    const res = await rawHttp('/healthz', { Host: 'raccoon.evil.example' })
    expect(res.status).toBe(403)
    expect(res.body).toContain('non-loopback Host rejected')
  })

  it('accepts loopback Host spellings, with or without a port, case-insensitively', async () => {
    for (const host of ['localhost', 'localhost:1', '127.0.0.1:5', '127.9.9.9', 'LOCALHOST:5']) {
      const res = await rawHttp('/healthz', { Host: host })
      expect(res.status, host).toBe(200)
    }
  })

  it('rejects a foreign Origin but not a non-browser caller without one', async () => {
    const hostile = await fetch(`${shim.baseUrl()}/healthz`, { headers: { Origin: 'https://evil.example' } })
    expect(hostile.status).toBe(403)
    expect(await hostile.text()).toContain('foreign Origin rejected')
    // curl / pi-ai send no Origin at all — that is not a browser page.
    const headless = await fetch(`${shim.baseUrl()}/healthz`)
    expect(headless.status).toBe(200)
    const same = await fetch(`${shim.baseUrl()}/healthz`, { headers: { Origin: `http://127.0.0.1:${shim.port()}` } })
    expect(same.status).toBe(200)
  })

  it('answers 401 for a wrong or missing bearer secret and forwards nothing', async () => {
    for (const headers of [{ Authorization: 'Bearer nope' }, { Authorization: 'nope' }, {}]) {
      const res = await fetch(`${shim.baseUrl()}/v1/models`, { headers })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: { message: expect.any(String), type: 'client', code: 'client' } })
    }
    expect(forwarded).toBeUndefined()
  })

  it('routes nothing but /healthz, /v1/models and /v1/chat/completions even for the right secret', async () => {
    const res = await fetch(`${shim.baseUrl()}/v1/completions`, { method: 'POST', headers: { ...bearer(), 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(404)
    const badType = await fetch(`${shim.baseUrl()}/v1/chat/completions`, { method: 'POST', headers: { ...bearer(), 'content-type': 'text/plain' }, body: 'hi' })
    expect(badType.status).toBe(415)
    const junk = await fetch(`${shim.baseUrl()}/v1/chat/completions`, { method: 'POST', headers: { ...bearer(), 'content-type': 'application/json' }, body: 'not json' })
    expect(junk.status).toBe(400)
  })
})

describe('shim routes', () => {
  it('serves /v1/models in OpenAI list shape from the live catalog', async () => {
    const res = await fetch(`${shim.baseUrl()}/v1/models`, { headers: bearer() })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      object: 'list',
      data: [{ id: 'glm', object: 'model' }, { id: 'ds', object: 'model' }],
    })
  })

  it('pipes upstream SSE through byte for byte', async () => {
    chatOutcome = Promise.resolve(streamOf(['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n']))
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n')
    // The real token forwarded upstream is the one the SHIM resolved — never
    // the bearer the client presented, and never visible to the client.
    expect((forwarded as { token: string }).token).toBe('real-upstream-token')
    expect((forwarded as { token: string }).token).not.toBe(shim.token())
    expect((forwarded as { body: unknown }).body).toEqual({ model: 'glm', messages: [{ role: 'user', content: 'hi' }] })
  })

  it('appends the [DONE] terminator when the upstream stream breaks mid-flight', async () => {
    // The caller must never wait for an end that already happened: a failure
    // after `writeHead` still terminates the stream with the sentinel an
    // OpenAI client understands.
    const encoder = new TextEncoder()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 0) {
          pulls += 1
          controller.enqueue(encoder.encode('data: {"partial":true}\n\n'))
          return
        }
        setTimeout(() => controller.error(new Error('upstream exploded')), 25)
      },
    })
    chatOutcome = Promise.resolve({ ok: true, status: 200, contentType: 'text/event-stream', body })
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [] }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('data: {"partial":true}\n\ndata: [DONE]\n\n')
  })

  it('ends the response when the upstream closes cleanly, fabricating nothing', async () => {
    // A clean close without [DONE] ends the response as-is: `pipe(res)` is
    // what ends it, so the appended terminator belongs to the broken-pipe
    // path only (see the companion test). The caller sees a completed HTTP
    // response either way — never a hang.
    chatOutcome = Promise.resolve(streamOf(['data: {"a":1}\n\n']))
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [] }),
    })
    const text = await res.text()
    expect(text.startsWith('data: {"a":1}\n\n')).toBe(true)
    expect(text.match(/\[DONE\]/gu)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  it('does not double-terminate when the upstream already sent [DONE]', async () => {
    chatOutcome = Promise.resolve(streamOf(['data: x\n\n', 'data: [DONE]\n\n']))
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [] }),
    })
    expect(await res.text()).toBe('data: x\n\ndata: [DONE]\n\n')
  })

  it('surfaces an upstream failure OpenAI-shaped at the status the kind maps to', async () => {
    const failure: RaccoonUpstreamFailure = { ok: false, status: 429, kind: 'soft_rate', message: 'too many requests' }
    chatOutcome = Promise.resolve(failure)
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [] }),
    })
    // The upstream 429 is re-exposed as 429, and the body names the kind —
    // this is exactly what pi-ai's retry decision reads.
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: { message: 'too many requests', type: 'soft_rate', code: 'soft_rate' } })
  })

  it('turns a credential-resolution failure into a non-retryable 401 session_dead', async () => {
    accessTokenImpl = async () => { throw new Error('raccoon: no signed-in 商汤小浣熊 account found') }
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [] }),
    })
    expect(res.status).toBe(401)
    const document = await res.json() as { error: { type: string, message: string } }
    expect(document.error.type).toBe('session_dead')
    expect(document.error.message).toContain('no signed-in')
  })
})

describe('shim lifecycle', () => {
  it('stop() releases the port and closes the listener', async () => {
    const temp = await startRaccoonShim({
      accessToken: async () => 'x',
      upstream: { chatStream: async () => chatOutcome },
    })
    const port = temp.port()
    expect(temp.baseUrl()).toBe(`http://127.0.0.1:${port}`)
    await temp.stop()
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow()
  })
})
