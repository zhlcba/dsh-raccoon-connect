import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearHostHeartbeat,
  heartbeatPresent,
  hostHeartbeatPath,
  hostStatus,
  isProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  writeHostHeartbeat,
} from '../src/heartbeat.ts'

/**
 * The heartbeat the host leaves so the CLI can tell "a DSH window has this
 * group right now" apart from "a crash left a note behind".
 *
 * The invariants are the ones PID checks alone cannot give:
 * - no file is `not-started`, a dead PID is `stale`;
 * - a live PID is NOT automatically running: PID reuse means a host whose
 *   recorded registration predates the process's own start time is a stranger,
 *   and only a live process that started BEFORE its note can be `running`;
 * - the file is read defensively: garbage or a foreign version reads as no
 *   heartbeat, never as a crash in `status`.
 *
 * Everything runs under a temp `DSH_HOME`. The start-time discrimination uses
 * the real `processStartTimeMs` against this process's own PID — `ps` on
 * POSIX, PowerShell on Windows — so the clock comparison is real, not mocked.
 */

let home: string
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'raccoon-heartbeat-'))
  savedEnv.DSH_HOME = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (savedEnv.DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedEnv.DSH_HOME
  rmSync(home, { recursive: true, force: true, maxRetries: 4 })
})

function writeHeartbeat(fields: Record<string, unknown>): void {
  writeFileSync(hostHeartbeatPath(), JSON.stringify({ version: 1, package: 'dsh-raccoon-connect', pluginVersion: '0.1.0', ...fields }))
}

describe('write / read / clear', () => {
  it('round-trips this process’s registration and clears it to absent', () => {
    expect(readHostHeartbeat()).toBeUndefined()
    expect(heartbeatPresent()).toBe(false)
    writeHostHeartbeat('0.1.0')
    const record = readHostHeartbeat()
    expect(record?.pid).toBe(process.pid)
    expect(record?.pluginVersion).toBe('0.1.0')
    expect(record?.registeredAt).toBeLessThanOrEqual(Date.now())
    expect(heartbeatPresent()).toBe(true)
    // mode 0600 where permission bits are real.
    if (process.platform !== 'win32') {
      expect(statSync(hostHeartbeatPath()).mode & 0o777).toBe(0o600)
    }
    clearHostHeartbeat()
    expect(readHostHeartbeat()).toBeUndefined()
    clearHostHeartbeat() // safe when there is none
  })

  it('rejects foreign versions, non-objects, and records without usable pid/at', () => {
    writeHeartbeat({ version: 2, pid: process.pid, registeredAt: 1 })
    expect(readHostHeartbeat()).toBeUndefined()
    writeFileSync(hostHeartbeatPath(), 'garbage{')
    expect(readHostHeartbeat()).toBeUndefined()
    writeFileSync(hostHeartbeatPath(), '[1,2]')
    expect(readHostHeartbeat()).toBeUndefined()
    writeHeartbeat({ pid: 'not-a-number', registeredAt: 1 })
    expect(readHostHeartbeat()).toBeUndefined()
    // The file may exist and still read as no heartbeat — presence is for
    // doctor, liveness is for status.
    expect(heartbeatPresent()).toBe(true)
  })
})

describe('isProcessAlive / processStartTimeMs', () => {
  it('finds this process alive and a never-assignable pid dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(2_147_483_647)).toBe(false)
  })

  it('reports when this process itself began', () => {
    const started = processStartTimeMs(process.pid)
    expect(typeof started).toBe('number')
    expect(started!).toBeLessThanOrEqual(Date.now())
    expect(started!).toBeGreaterThan(Date.now() - 30 * 60_000) // this test run only just started
    expect(processStartTimeMs(2_147_483_647)).toBeUndefined()
  })
})

describe('hostStatus', () => {
  it('says not-started when no file exists at all', () => {
    expect(hostStatus()).toBe('not-started')
  })

  it('says stale when the recorded pid is dead, however recent the note', () => {
    writeHeartbeat({ pid: 2_147_483_647, registeredAt: Date.now() + 60_000 })
    expect(hostStatus()).toBe('stale')
  })

  it('says running for this live process when the note postdates its start', () => {
    writeHeartbeat({ pid: process.pid, registeredAt: Date.now() + 60_000 })
    expect(hostStatus()).toBe('running')
  })

  it('says stale when the pid is alive but began AFTER its own registration note — PID reuse', () => {
    // A host that died and left the file behind only *looks* alive once some
    // unrelated process takes its number; that stranger started after the
    // note claims it registered, and that ordering is the tell.
    const startedAt = processStartTimeMs(process.pid)
    expect(typeof startedAt).toBe('number')
    if (startedAt === undefined) return // start time not obtainable: the running arm above still holds
    writeHeartbeat({ pid: process.pid, registeredAt: startedAt - 5_000 })
    expect(hostStatus()).toBe('stale')
  })

  it('reads a garbage file as not-started instead of throwing', () => {
    writeFileSync(hostHeartbeatPath(), '{{{')
    expect(hostStatus()).toBe('not-started')
    const text = readFileSync(hostHeartbeatPath(), 'utf8')
    expect(text).toBe('{{{')
  })
})
