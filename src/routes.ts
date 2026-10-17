/**
 * The plugin's two same-origin HTTP routes.
 *
 * Both are mounted on the harness web server through `ctx.inject(['webServer'])`,
 * which keeps them harmless in a Desktop or TUI composition where no server
 * exists. Each is guarded the same way:
 *
 * - **Loopback Host and Origin.** The status route is readable by any process on
 *   this machine already (it is a local port), but a page on another origin
 *   reaching it through DNS rebinding should not learn which account is signed
 *   in or what its token expiry is.
 * - **In-process key, writes only.** The Origin guard defends against a foreign
 *   *page*; it does not authorize an *action*. So the probe route additionally
 *   requires `X-Raccoon-Probe-Key`, which is random per process and delivered
 *   only inside the status document the card already had to fetch.
 * - **Small bodies.** The probe route takes one tiny JSON action; anything
 *   larger is a bug or an attack, and 4 KiB is generous for both.
 *
 * Secrets are never rendered here: the status document carries no token, and the
 * probe key never reaches the logs.
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { constantTimeEquals, isLoopbackHost, isLoopbackOrigin } from './net-guard.ts'
import type { RaccoonProbeAction, RaccoonWebStatus } from './status-paths.ts'

/** Largest probe-request body. */
const MAX_PROBE_BODY = 4096

/** Header carrying the per-process probe key. Keep in step with the client. */
export const PROBE_KEY_HEADER = 'X-Raccoon-Probe-Key'

/** A key authorizing probe writes for this process. */
export function createProbeKey(): string {
  return randomBytes(24).toString('hex')
}

/** What the routes need from the runtime, as thunks so state is read fresh. */
export interface RaccoonRouteOptions {
  statusPath: string
  probePath: string
  probeKey: string
  buildStatus: () => Promise<RaccoonWebStatus>
  handleAction: (action: RaccoonProbeAction) => Promise<unknown>
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        rejectBody(new Error('body too large'))
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
 * Mount both routes and return a disposer removing them.
 *
 * Registration order does not matter to the server, but the two paths must be
 * distinct — a duplicate (kind, path) throws by design, which is the right
 * outcome for a misconfigured bundle.
 */
export function registerRaccoonRoutes(web: WebServer, options: RaccoonRouteOptions): () => void {
  const statusDispose = web.register({
    kind: 'exact',
    path: options.statusPath,
    handler: async (req, res) => {
      if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin)) {
        json(res, 403, { status: 'error', message: 'raccoon: loopback origin required' })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { status: 'error', message: 'raccoon: status is read-only' })
        return
      }
      try {
        json(res, 200, await options.buildStatus())
      } catch (error: unknown) {
        // The card renders `error` verbatim, so this is the user-visible failure
        // path; the message is already token-free by construction.
        json(res, 500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  const probeDispose = web.register({
    kind: 'exact',
    path: options.probePath,
    handler: async (req, res) => {
      if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin)) {
        json(res, 403, { error: 'raccoon: loopback origin required' })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'raccoon: probe actions are POST-only' })
        return
      }
      if (!constantTimeEquals(req.headers[PROBE_KEY_HEADER.toLowerCase()] as string | undefined ?? '', options.probeKey)) {
        json(res, 401, { error: 'raccoon: probe key missing or wrong' })
        return
      }
      let action: RaccoonProbeAction
      try {
        const body = await readBody(req, MAX_PROBE_BODY)
        const parsed: unknown = JSON.parse(body)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('expected an object')
        const fields = parsed as Record<string, unknown>
        const requested = fields['action']
        if (requested !== 'probe' && requested !== 'clear' && requested !== 'refresh') throw new Error('action must be probe, clear, or refresh')
        const model = typeof fields['model'] === 'string' ? fields['model'] : undefined
        action = { action: requested, ...(model === undefined ? {} : { model }) }
      } catch (error: unknown) {
        json(res, 400, { error: `raccoon: ${error instanceof Error ? error.message : String(error)}` })
        return
      }
      try {
        const result = await options.handleAction(action)
        json(res, 200, result ?? { ok: true })
      } catch (error: unknown) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  return () => {
    statusDispose()
    probeDispose()
  }
}
