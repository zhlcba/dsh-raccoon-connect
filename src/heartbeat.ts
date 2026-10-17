/**
 * A one-file record that a DSH process currently has this plugin registered.
 *
 * The plugin's CLI runs in its own process, so it cannot ask the harness whether
 * a provider is live. This heartbeat says so: the host writes it when a variant
 * registers and removes it on disposal, and the CLI reads it to tell "the web
 * session has this model group right now" apart from "a stale note left behind
 * by a crash", which is the difference between telling the user to look at their
 * open DSH window and telling them to start one.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** What a host writes about itself. */
export interface RaccoonHostHeartbeat {
  version: 1
  package: string
  pluginVersion: string
  registeredAt: number
  pid: number
}

/** Where the heartbeat lives. */
export function hostHeartbeatPath(): string {
  return join(resolveDshHome(), '.raccoon-host-heartbeat.json')
}

/** Record that this process registered the provider. Failures are silent. */
export function writeHostHeartbeat(pluginVersion: string): void {
  const record: RaccoonHostHeartbeat = {
    version: 1,
    package: 'dsh-raccoon-connect',
    pluginVersion,
    registeredAt: Date.now(),
    pid: process.pid,
  }
  try {
    writeFileSync(hostHeartbeatPath(), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // A read-only home costs the CLI its liveness check, nothing more.
  }
}

/** Remove this process's heartbeat. Safe when there is none. */
export function clearHostHeartbeat(): void {
  try {
    rmSync(hostHeartbeatPath(), { force: true })
  } catch {
    // Nothing to clean up.
  }
}

/** Read the heartbeat, or undefined when absent or unreadable. */
export function readHostHeartbeat(): RaccoonHostHeartbeat | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(hostHeartbeatPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (record['version'] !== 1) return undefined
    if (typeof record['pid'] !== 'number' || typeof record['registeredAt'] !== 'number') return undefined
    return {
      version: 1,
      package: typeof record['package'] === 'string' ? record['package'] : '',
      pluginVersion: typeof record['pluginVersion'] === 'string' ? record['pluginVersion'] : '',
      registeredAt: record['registeredAt'],
      pid: record['pid'],
    }
  } catch {
    return undefined
  }
}

/** Whether a process id is alive. */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    // Signal 0 performs the existence and permission checks without sending.
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    // ESRCH is dead; EPERM means alive but not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Liveness of the host that wrote the heartbeat.
 *
 * A bare PID check is wrong often enough to matter: process ids are recycled, so
 * a host that died and left the file behind looks alive as soon as some unrelated
 * process takes the number. When the recorded start time is obtainable, a host
 * that began *after* its own registration note can only be a stranger. When it is
 * not obtainable, liveness alone is reported — a conservative "probably running".
 */
export function hostStatus(): 'running' | 'stale' | 'not-started' {
  const record = readHostHeartbeat()
  if (record === undefined) return 'not-started'
  if (!isProcessAlive(record.pid)) return 'stale'
  const startedAt = processStartTimeMs(record.pid)
  if (startedAt !== undefined && startedAt > record.registeredAt) return 'stale'
  return 'running'
}

/**
 * When a process began, in epoch milliseconds, when it can be determined.
 *
 * POSIX asks `ps`; Windows asks PowerShell, because `wmic` — what older tooling
 * used — is gone from current builds. Both are best effort: an unparseable answer
 * returns undefined rather than making the caller guess.
 */
export function processStartTimeMs(pid: number): number | undefined {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: 'utf8', timeout: 4000, windowsHide: true })
      const at = Date.parse(String(out).trim())
      return Number.isNaN(at) ? undefined : at
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 4000 })
    const at = Date.parse(out.trim())
    return Number.isNaN(at) ? undefined : at
  } catch {
    return undefined
  }
}

/** Whether the heartbeat file exists at all, for `doctor` output. */
export function heartbeatPresent(): boolean {
  return existsSync(hostHeartbeatPath())
}
