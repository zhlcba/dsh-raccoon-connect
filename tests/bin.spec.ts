import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectStatus, parseArgs, renderStatus, run, safeMessage } from '../src/bin.ts'
import { RACCOON_PRIMARY } from '../src/variants.ts'

/**
 * The command line. Read-only commands are pinned to NEVER refreshing: 小浣熊's
 * refresh token is single-use, so a command typed to "just look" must not be
 * the thing that rotates the desktop app's session.
 *
 * Everything runs against a temp `DSH_HOME` and a `RACCOON_AUTH_FILE` that
 * points either nowhere (the signed-out machine) or at a temp fixture.
 */

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
const makeJwt = (claims: Record<string, unknown>): string => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`

let home: string
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'raccoon-bin-'))
  for (const key of ['DSH_HOME', 'RACCOON_AUTH_FILE', 'BOX_AGENT_CONFIG_DIR']) {
    savedEnv[key] = process.env[key]
  }
  process.env.DSH_HOME = home
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 4 })
})

describe('parseArgs', () => {
  it('defaults to status and accepts each command with --json in any position', () => {
    expect(parseArgs([])).toEqual({ command: 'status', json: false, provider: 'raccoon' })
    expect(parseArgs(['doctor', '--json'])).toEqual({ command: 'doctor', json: true, provider: 'raccoon' })
    expect(parseArgs(['--json', 'logout'])).toEqual({ command: 'logout', json: true, provider: 'raccoon' })
    expect(parseArgs(['help'])).toEqual({ command: 'help', json: false, provider: 'raccoon' })
  })

  it('takes the provider in both the spaced and the = form', () => {
    expect(parseArgs(['status', '--provider', 'raccoon'])).toEqual({ command: 'status', json: false, provider: 'raccoon' })
    expect(parseArgs(['status', '--provider=raccoon'])).toEqual({ command: 'status', json: false, provider: 'raccoon' })
    expect(parseArgs(['--provider'])).toEqual({ error: '--provider needs a value' })
  })

  it('reports rather than ignores unknown options, commands, and providers', () => {
    expect(parseArgs(['status', '--verbose'])).toEqual({ error: 'unknown option --verbose' })
    expect(parseArgs(['teleport'])).toEqual({ error: 'unknown command teleport' })
    expect(parseArgs(['status', '--provider=workbuddy'])).toEqual({ error: 'unknown provider workbuddy' })
  })
})

describe('safeMessage', () => {
  it('redacts JWT-shaped strings and access_token=… assignments out of terminal output', () => {
    const jwt = makeJwt({ iss: 'https://x', name: 'alice', exp: 5 })
    expect(safeMessage(`failed with ${jwt} at auth`)).toBe('failed with <token> at auth')
    expect(safeMessage('refresh rejected access_token=abcdefghij0123456789')).toContain('access_token=<token>')
    expect(safeMessage('refresh_token: "abcdefghij0123456789"')).toBe('refresh_token=<token>"')
    // Ordinary text rides through unchanged — redaction is not a mangler.
    expect(safeMessage('HTTP 429 too many requests')).toBe('HTTP 429 too many requests')
  })
})

describe('collectStatus / renderStatus on a signed-out machine', () => {
  it('says signed-out with no desktop file, no heartbeat, and a doctor hint', async () => {
    process.env.RACCOON_AUTH_FILE = join(home, 'nowhere', 'auth.json')
    const status = await collectStatus('raccoon')
    expect(status.state).toBe('signed-out')
    expect(status.desktopFilePresent).toBe(false)
    expect(status.host).toBe('not-started')
    expect(status.provider).toBe('raccoon')
    expect(status.pluginVersion).toMatch(/^\d+\.\d+\.\d+/u)
    expect(status.ownAuthPath).toBe(join(home, RACCOON_PRIMARY.ownFilename)) // DSH_HOME honored, not ~/.dsh
    expect(status.notes.join('\n')).toContain('未发现小浣熊登录文件')
    // The read collected no token anywhere in the structure.
    expect(JSON.stringify(status)).not.toContain('access_token')

    const lines = renderStatus(status)
    expect(lines.some(line => line.includes('未登录'))).toBe(true)
    expect(lines.some(line => line.includes('App 凭据') && line.includes('缺失'))).toBe(true)
    expect(lines.some(line => line.includes('宿主状态') && line.includes('当前没有运行中'))).toBe(true)
  })

  it('reports a signed-in desktop credential with identity, source, and remaining minutes', async () => {
    const exp = Math.floor((Date.now() + 30 * 60_000) / 1000)
    const token = makeJwt({ iss: 'https://x', name: 'alice', exp })
    const desktop = join(home, 'auth.json')
    const original = JSON.stringify({
      access_token: token,
      refresh_token: makeJwt({ iss: 'https://x', name: 'alice', exp: exp + 100_000 }),
      office_identity: 'org-7',
      office_org_name: 'SenseTime',
    })
    writeFileSync(desktop, original)
    process.env.RACCOON_AUTH_FILE = desktop
    const status = await collectStatus('raccoon')
    expect(status.state).toBe('signed-in')
    expect(status.nickname).toBe('alice')
    expect(status.identity).toBe('org-7')
    expect(status.orgName).toBe('SenseTime')
    expect(status.source).toBe('desktop')
    expect(status.desktopFilePresent).toBe(true)
    expect(status.expiresInSec).toBeGreaterThan(1700)
    expect(status.expiresInSec).toBeLessThan(1900)
    expect(status.refreshExpiresAt).toBe((exp + 100_000) * 1000)
    // Read-only both ways: no token leaks into the report, and `status` must
    // not be the thing that rotates the desktop app's single-use session.
    expect(JSON.stringify(status)).not.toContain(token)
    expect(readFileSync(desktop, 'utf8')).toBe(original)

    const lines = renderStatus(status)
    expect(lines.some(line => line.includes('已登录'))).toBe(true)
    expect(lines.some(line => line.includes('小浣熊 App 文件'))).toBe(true)
    expect(lines.some(line => line.includes('alice'))).toBe(true)
  })
})

describe('run', () => {
  function capture(): { lines: { log: string[], error: string[] }, output: { log: (line: string) => void, error: (line: string) => void } } {
    const lines = { log: [] as string[], error: [] as string[] }
    return {
      lines,
      output: { log: line => { lines.log.push(line) }, error: line => { lines.error.push(line) } },
    }
  }

  it('prints usage to the error stream and exits 2 on an unparseable command line', async () => {
    const { lines, output } = capture()
    expect(await run(['bogus'], output)).toBe(2)
    expect(lines.error[0]).toBe('unknown command bogus')
    expect(lines.error.join('\n')).toContain('用法')
    expect(lines.log).toEqual([])
  })

  it('emits one machine-readable JSON line for status --json', async () => {
    process.env.RACCOON_AUTH_FILE = join(home, 'absent.json')
    const { lines, output } = capture()
    expect(await run(['status', '--json'], output)).toBe(0)
    expect(lines.log).toHaveLength(1)
    const document = JSON.parse(lines.log[0]!) as { state: string, provider: string }
    expect(document).toMatchObject({ state: 'signed-out', provider: 'raccoon' })
  })

  it('help exits 0 without touching any credential path', async () => {
    const { lines, output } = capture()
    expect(await run(['help'], output)).toBe(0)
    expect(lines.log.join('\n')).toContain('logout')
  })

  it('logout deletes only the plugin’s own copy, lock, and backup', async () => {
    const desktop = join(home, 'auth.json')
    writeFileSync(desktop, JSON.stringify({ access_token: 'opaque', refresh_token: 'R' }))
    process.env.RACCOON_AUTH_FILE = desktop
    const ownPath = join(home, RACCOON_PRIMARY.ownFilename)
    const lockPath = `${ownPath}.lock`
    const backupPath = join(home, `${RACCOON_PRIMARY.ownFilename}-desktop-backup`)
    writeFileSync(ownPath, 'copy')
    writeFileSync(lockPath, '')
    writeFileSync(backupPath, 'backup')
    const { output } = capture()
    expect(await run(['logout'], output)).toBe(0)
    expect(existsSync(ownPath)).toBe(false)
    expect(existsSync(lockPath)).toBe(false)
    expect(existsSync(backupPath)).toBe(false)
    expect(existsSync(desktop)).toBe(true)
  })

  it('doctor on the signed-out machine exits non-zero so it can gate a script', async () => {
    process.env.RACCOON_AUTH_FILE = join(home, 'absent.json')
    const { lines, output } = capture()
    expect(await run(['doctor'], output)).toBe(1)
    expect(lines.log.join('\n')).toContain('内置兜底名册')
  })
})
