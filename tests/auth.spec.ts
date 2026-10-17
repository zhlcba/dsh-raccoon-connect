import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeJwtClaims, desktopAuthCandidatesFor, parseDesktopAuth, RaccoonCredentialStore } from '../src/auth.ts'
import type { RaccoonRefreshOutcome, RaccoonStoreOptions } from '../src/auth.ts'
import { RACCOON_PRIMARY } from '../src/variants.ts'

/**
 * Credential resolution and the demand-driven, write-back refresh.
 *
 * The invariants pinned here are the ones this store exists for:
 * - the desktop file is the authority — after an account switch its copy wins
 *   by identity even when the plugin's own copy outlives it by expiry;
 * - refresh is single-flight, because 小浣熊's refresh token is single-use and
 *   two concurrent refreshes would strand one caller;
 * - rotated tokens are written back to the desktop file in the app's own shape
 *   (app key order, the app's other fields preserved, mode 0600, atomic
 *   replace) with a one-time backup, so the plugin never logs the app out;
 * - a `refresh_conflict` is recovered by re-reading what the app left behind;
 * - a failed refresh cannot take down a not-yet-expired session, and the error
 *   text never carries the tokens it was holding;
 * - `status()` never throws; `logout()` deletes only the plugin's own files.
 *
 * The store's `writeFileAtomic`/`withFileLock` legs run for real against a
 * temp directory — that is the point: atomic replace, lock cleanup, and (on
 * POSIX) the 0600 mode bits. Nothing here touches `~/.dsh` or `~/.box-agent`:
 * `DSH_HOME`, `RACCOON_AUTH_FILE`, and `BOX_AGENT_CONFIG_DIR` are redirected to
 * a temp home and restored after every test.
 */

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A JWT-shaped string with the given claims and a fixed fake signature. */
const makeJwt = (claims: Record<string, unknown>): string =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.ZmFrZXNpZw`

const MINUTE = 60_000

let home: string
let desktopDir: string
let ownDir: string
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'raccoon-auth-'))
  desktopDir = join(home, 'box-agent-config')
  ownDir = join(home, 'dsh-home')
  mkdirSync(desktopDir, { recursive: true })
  mkdirSync(ownDir, { recursive: true })
  for (const key of ['DSH_HOME', 'RACCOON_AUTH_FILE', 'BOX_AGENT_CONFIG_DIR']) {
    savedEnv[key] = process.env[key]
    process.env[key] = undefined
  }
  process.env.DSH_HOME = ownDir
})

afterEach(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 4 })
})

/** Write a desktop credential document and return its path. */
function writeDesktop(doc: Record<string, unknown>, dir = desktopDir): string {
  const path = join(dir, 'auth.json')
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`)
  return path
}

/** The plugin-owned copy path this store uses by variant convention. */
function ownPathIn(dir: string): string {
  return join(dir, RACCOON_PRIMARY.ownFilename)
}

function makeStore(options: {
  desktopPath: string
  ownPath: string
  refresh: (token: string) => Promise<RaccoonRefreshOutcome>
  fs?: RaccoonStoreOptions['fs'] | undefined
}): RaccoonCredentialStore {
  const { fs, ...rest } = options
  return new RaccoonCredentialStore({
    variant: RACCOON_PRIMARY,
    ...rest,
    ...(fs === undefined ? {} : { fs }),
  })
}

describe('desktop credential candidates', () => {
  it('short-circuits to RACCOON_AUTH_FILE, then honors BOX_AGENT_CONFIG_DIR, then the app default', () => {
    const explicit = join(home, 'somewhere-else.json')
    process.env.RACCOON_AUTH_FILE = explicit
    process.env.BOX_AGENT_CONFIG_DIR = desktopDir
    expect(desktopAuthCandidatesFor(RACCOON_PRIMARY)).toEqual([explicit])

    delete process.env.RACCOON_AUTH_FILE
    expect(desktopAuthCandidatesFor(RACCOON_PRIMARY)).toEqual([join(desktopDir, 'auth.json')])

    delete process.env.BOX_AGENT_CONFIG_DIR
    const [candidate] = desktopAuthCandidatesFor(RACCOON_PRIMARY)
    expect(candidate).toBe(join(homedir(), '.box-agent', 'config', 'auth.json'))
  })

  it('exposes the effective paths for diagnostics and reports presence via stat', async () => {
    const desktopPath = writeDesktop({ access_token: makeJwt({ iss: 'iss', name: 'n' }) })
    const store = makeStore({ desktopPath, ownPath: ownPathIn(ownDir), refresh: async () => ({ accessToken: 'x' }) })
    expect(store.desktopAuthPath()).toBe(desktopPath)
    expect(store.ownAuthPath()).toBe(ownPathIn(ownDir))
    await expect(store.desktopFilePresent()).resolves.toBe(true)
    store.setDesktopPath(join(home, 'never-written.json'))
    await expect(store.desktopFilePresent()).resolves.toBe(false)
  })
})

describe('decodeJwtClaims / parseDesktopAuth', () => {
  it('decodes claims without verifying signatures and yields {} for anything malformed', () => {
    const claims = { exp: 100, name: 'alice', iss: 'https://x' }
    expect(decodeJwtClaims(makeJwt(claims))).toEqual(claims)
    expect(decodeJwtClaims('not-a-jwt')).toEqual({})
    expect(decodeJwtClaims(`header.${b64url([1, 2])}.sig`)).toEqual({})
    expect(decodeJwtClaims(`${b64url(claims)}.${'%%%not base64 json%%%'}.sig`)).toEqual({})
  })

  it('accepts the access_token key and the token / auth_token aliases the app reader accepts', () => {
    const token = makeJwt({ iss: 'iss', name: 'alice', exp: 5000 })
    expect(parseDesktopAuth(JSON.stringify({ access_token: token }))?.accessToken).toBe(token)
    expect(parseDesktopAuth(JSON.stringify({ token }))?.accessToken).toBe(token)
    expect(parseDesktopAuth(JSON.stringify({ auth_token: token }))?.accessToken).toBe(token)
    // access_token wins when several spellings coexist.
    expect(parseDesktopAuth(JSON.stringify({ access_token: token, token: 'other' }))?.accessToken).toBe(token)
  })

  it('derives expiry from the JWT exp claim and never from a document field', () => {
    const future = Math.floor((Date.now() + 60 * MINUTE) / 1000)
    const credential = parseDesktopAuth(JSON.stringify({
      access_token: makeJwt({ exp: future, name: 'alice' }),
      refresh_token: makeJwt({ exp: future + 1000 }),
    }))
    expect(credential?.expiresAtMs).toBe(future * 1000)
    expect(credential?.refreshExpiresAtMs).toBe((future + 1000) * 1000)
    expect(credential?.nickname).toBe('alice')
    // Unparsable tokens mean "expiry unknown", which callers treat as never
    // refreshing, not as expired.
    const bare = parseDesktopAuth(JSON.stringify({ access_token: 'x' }))
    expect(bare?.expiresAtMs).toBe(0)
    expect(bare?.refreshExpiresAtMs).toBeUndefined()
  })

  it('keeps the office identity fields and keys accounts stably', () => {
    const credential = parseDesktopAuth(JSON.stringify({
      access_token: makeJwt({ iss: 'https://x', name: 'alice' }),
      refresh_token: makeJwt({ exp: 9 }),
      office_identity: 'org-7',
      office_org_name: 'SenseTime',
      office_org_role: 'admin',
    }))
    expect(credential?.identity).toBe('org-7')
    expect(credential?.orgName).toBe('SenseTime')
    expect(credential?.orgRole).toBe('admin')
    expect(credential?.source).toBe('desktop')
    // `sid` changes every login; the stable key is iss + name.
    expect(credential?.accountId).toBe('https://x:alice')
    const anonymous = parseDesktopAuth(JSON.stringify({ access_token: 'opaque-token-A' }))
    const other = parseDesktopAuth(JSON.stringify({ access_token: 'opaque-token-B' }))
    expect(anonymous?.accountId).toMatch(/^token:[0-9a-f]+$/u)
    // Two different unknown accounts cannot collide into one saved catalog.
    expect(anonymous?.accountId).not.toBe(other?.accountId)
  })

  it('rejects unparsable JSON, non-objects, and documents without any access token', () => {
    expect(parseDesktopAuth('{')).toBeUndefined()
    expect(parseDesktopAuth('[]')).toBeUndefined()
    expect(parseDesktopAuth('"text"')).toBeUndefined()
    expect(parseDesktopAuth('{}')).toBeUndefined()
    expect(parseDesktopAuth('{"access_token": "   "}')).toBeUndefined()
  })
})

describe('RaccoonCredentialStore.current', () => {
  it('reads through the env-resolved desktop candidate with no explicit path', async () => {
    const desktopPath = writeDesktop({ access_token: makeJwt({ iss: 'i', name: 'n', exp: 99999 }) })
    process.env.RACCOON_AUTH_FILE = desktopPath
    const store = new RaccoonCredentialStore({
      variant: RACCOON_PRIMARY,
      ownPath: ownPathIn(ownDir),
      refresh: async () => ({ accessToken: 'x' }),
    })
    const credential = await store.current()
    expect(credential?.source).toBe('desktop')
    expect(credential?.expiresAtMs).toBe(99999 * 1000)
  })

  it('prefers the plugin copy when it is fresher under the same identity', async () => {
    const desktopPath = writeDesktop({ access_token: makeJwt({ iss: 'i', name: 'alice', exp: Math.floor((Date.now() + 10 * MINUTE) / 1000) }) })
    const ownToken = makeJwt({ iss: 'i', name: 'alice' })
    writeFileSync(ownPathIn(ownDir), JSON.stringify({
      version: 1,
      credential: {
        accessToken: ownToken,
        refreshToken: '',
        expiresAtMs: Date.now() + 60 * MINUTE,
        accountId: 'i:alice',
      },
    }))
    const store = makeStore({ desktopPath, ownPath: ownPathIn(ownDir), refresh: async () => ({ accessToken: 'x' }) })
    const credential = await store.current()
    expect(credential?.source).toBe('dsh')
    expect(credential?.accessToken).toBe(ownToken)
  })

  it('lets identity beat expiry after an account switch in the desktop app', async () => {
    // The copy belongs to alice and outlives bob's token; answering as alice
    // would leak the previous account's identity into a live session.
    const desktopPath = writeDesktop({ access_token: makeJwt({ iss: 'i', name: 'bob', exp: Math.floor((Date.now() + 10 * MINUTE) / 1000) }) })
    writeFileSync(ownPathIn(ownDir), JSON.stringify({
      version: 1,
      credential: {
        accessToken: makeJwt({ iss: 'i', name: 'alice' }),
        refreshToken: '',
        expiresAtMs: Date.now() + 30 * 24 * 60 * MINUTE,
        accountId: 'i:alice',
      },
    }))
    const store = makeStore({ desktopPath, ownPath: ownPathIn(ownDir), refresh: async () => ({ accessToken: 'x' }) })
    const credential = await store.current()
    expect(credential?.accountId).toBe('i:bob')
    expect(credential?.source).toBe('desktop')
  })

  it('treats a present-but-unparsable desktop file as authoritative, never falling through', async () => {
    const desktopPath = join(desktopDir, 'auth.json')
    writeFileSync(desktopPath, '{ this is not json')
    const store = makeStore({ desktopPath, ownPath: ownPathIn(ownDir), refresh: async () => ({ accessToken: 'x' }) })
    expect(await store.current()).toBeUndefined()
  })

  it('rejects foreign versions and shapes of the plugin-owned copy', async () => {
    const desktopPath = join(desktopDir, 'missing.json')
    writeFileSync(ownPathIn(ownDir), JSON.stringify({ version: 2, credential: { accessToken: 'a', expiresAtMs: 0, accountId: 'x' } }))
    const store = makeStore({ desktopPath, ownPath: ownPathIn(ownDir), refresh: async () => ({ accessToken: 'x' }) })
    expect(await store.current()).toBeUndefined()
    writeFileSync(ownPathIn(ownDir), JSON.stringify({ version: 1, credential: { accessToken: '', expiresAtMs: 0, accountId: 'x' } }))
    expect(await store.current()).toBeUndefined()
  })
})

describe('RaccoonCredentialStore.resolve — refresh and write-back', () => {
  it('refreshes at most once for concurrent callers and rewrites the desktop file in the app shape', async () => {
    const oldAccess = makeJwt({ iss: 'i', name: 'alice', exp: Math.floor((Date.now() + MINUTE) / 1000) })
    const oldRefresh = makeJwt({ iss: 'i', name: 'alice', exp: Math.floor((Date.now() + 30 * 24 * 60 * MINUTE) / 1000) })
    const newExpSec = Math.floor((Date.now() + 60 * MINUTE) / 1000)
    const newAccess = makeJwt({ iss: 'i', name: 'alice', exp: newExpSec })
    const newRefresh = makeJwt({ iss: 'i', name: 'alice', exp: Math.floor((Date.now() + 31 * 24 * 60 * MINUTE) / 1000) })
    const desktopPath = writeDesktop({
      theme: 'dark',
      access_token: oldAccess,
      refresh_token: oldRefresh,
      office_identity: 'personal',
      office_org_name: 'SenseTime',
    })
    const original = readFileSync(desktopPath, 'utf8')
    const calls: string[] = []
    const ownPath = ownPathIn(ownDir)
    const store = makeStore({
      desktopPath,
      ownPath,
      refresh: async token => {
        calls.push(token)
        // A slow refresh: both callers must join it rather than burn the
        // single-use token twice.
        await new Promise(resolve => setTimeout(resolve, 20))
        return { accessToken: newAccess, refreshToken: newRefresh }
      },
    })
    const [first, second] = await Promise.all([store.resolve(), store.resolve()])
    expect(calls).toEqual([oldRefresh])
    expect(first.accessToken).toBe(newAccess)
    expect(second.accessToken).toBe(newAccess)
    expect(first.source).toBe('dsh')
    expect(first.expiresAtMs).toBe(newExpSec * 1000)

    // The app's own key order leads, its unrelated fields survive, and the
    // aliases give way to the canonical pair.
    const rewritten = JSON.parse(readFileSync(desktopPath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(rewritten).slice(0, 2)).toEqual(['access_token', 'refresh_token'])
    expect(rewritten['access_token']).toBe(newAccess)
    expect(rewritten['refresh_token']).toBe(newRefresh)
    expect(rewritten['theme']).toBe('dark')
    expect(rewritten['office_identity']).toBe('personal')
    expect(rewritten['office_org_name']).toBe('SenseTime')

    // The plugin's own copy is a versioned document, and the first overwrite
    // left a rollback of exactly what it replaced.
    const own = JSON.parse(readFileSync(ownPath, 'utf8')) as { version: number, credential: { accessToken: string, identity?: string } }
    expect(own.version).toBe(1)
    expect(own.credential.accessToken).toBe(newAccess)
    expect(own.credential.identity).toBe('personal')
    const backupPath = join(ownDir, `${RACCOON_PRIMARY.ownFilename}-desktop-backup`)
    expect(readFileSync(backupPath, 'utf8')).toBe(original)

    // The file lock is released; only the credential and its backup remain.
    expect(existsSync(`${ownPath}.lock`)).toBe(false)
    if (process.platform !== 'win32') {
      expect(statSync(ownPath).mode & 0o777).toBe(0o600)
      expect(statSync(desktopPath).mode & 0o777).toBe(0o600)
    }
  })

  it('keeps the old refresh token when the upstream rotates only the access token', async () => {
    const oldAccess = makeJwt({ iss: 'i', name: 'a', exp: Math.floor((Date.now() + MINUTE) / 1000) })
    const desktopPath = writeDesktop({ access_token: oldAccess, refresh_token: 'R1' })
    const store = makeStore({
      desktopPath,
      ownPath: ownPathIn(ownDir),
      refresh: async () => ({ accessToken: makeJwt({ iss: 'i', name: 'a', exp: Math.floor((Date.now() + 60 * MINUTE) / 1000) }) }),
    })
    const credential = await store.resolve()
    expect(credential.refreshToken).toBe('R1')
  })

  it('recovers from refresh_conflict by re-reading what the desktop app left', async () => {
    const oldAccess = makeJwt({ iss: 'i', name: 'alice', exp: Math.floor((Date.now() + MINUTE) / 1000) })
    const desktopPath = writeDesktop({ access_token: oldAccess, refresh_token: 'R1' })
    const liveAccess = makeJwt({ iss: 'i', name: 'alice', exp: Math.floor((Date.now() + 40 * MINUTE) / 1000) })
    const store = makeStore({
      desktopPath,
      ownPath: ownPathIn(ownDir),
      refresh: async () => {
        // The app refreshed between our read and our exchange: its file now
        // carries a live pair and our R1 comes back refused as reused.
        writeFileSync(desktopPath, JSON.stringify({ access_token: liveAccess, refresh_token: 'R2' }))
        throw new Error('upstream said: 200822 refresh_conflict')
      },
    })
    const credential = await store.resolve()
    expect(credential.accessToken).toBe(liveAccess)
    expect(credential.source).toBe('desktop')
  })

  it('returns a not-yet-expired token when the refresh endpoint is down', async () => {
    // Inside the five-minute margin but far from hard expiry: an unreachable
    // refresh endpoint must not take down a session that still works.
    const access = makeJwt({ iss: 'i', name: 'a', exp: Math.floor((Date.now() + 4 * MINUTE) / 1000) })
    const desktopPath = writeDesktop({ access_token: access, refresh_token: 'R' })
    const store = makeStore({
      desktopPath,
      ownPath: ownPathIn(ownDir),
      refresh: async () => { throw new Error('econnrefused') },
    })
    const credential = await store.resolve()
    expect(credential.accessToken).toBe(access)
    expect(existsSync(ownPathIn(ownDir))).toBe(false)
  })

  it('throws an expiry error with the held tokens redacted once the token is gone', async () => {
    const access = makeJwt({ iss: 'i', name: 'a', exp: Math.floor((Date.now() - MINUTE) / 1000) })
    const desktopPath = writeDesktop({ access_token: access, refresh_token: 'R1' })
    const store = makeStore({
      desktopPath,
      ownPath: ownPathIn(ownDir),
      refresh: async () => { throw new Error(`rejected ${access} for R1`) },
    })
    await expect(store.resolve()).rejects.toThrow(/token refresh failed and the access token is expired/u)
    const message = await store.resolve().then(() => 'no-throw', error => String((error as Error).message))
    expect(message).not.toContain(access)
    expect(message).not.toContain('R1')
    expect(message).toContain('<redacted>')
  })

  it('refuses to invent a session when nothing is signed in', async () => {
    const store = makeStore({
      desktopPath: join(desktopDir, 'absent.json'),
      ownPath: ownPathIn(ownDir),
      refresh: async () => ({ accessToken: 'x' }),
    })
    await expect(store.resolve()).rejects.toThrow(/no signed-in 商汤小浣熊 account/u)
  })

  it('never refreshes an unparsable-expiry token — unknown is not expired', async () => {
    const desktopPath = writeDesktop({ access_token: 'opaque', refresh_token: 'R' })
    let refreshed = 0
    const store = makeStore({
      desktopPath,
      ownPath: ownPathIn(ownDir),
      refresh: async () => { refreshed += 1; return { accessToken: 'x' } },
    })
    const credential = await store.resolve()
    expect(credential.accessToken).toBe('opaque')
    expect(refreshed).toBe(0)
  })
})

describe('RaccoonCredentialStore.status / logout', () => {
  it('reports the sign-in summary without ever refreshing', async () => {
    const exp = Math.floor((Date.now() + 60 * MINUTE) / 1000)
    const desktopPath = writeDesktop({
      access_token: makeJwt({ iss: 'i', name: 'alice', exp }),
      refresh_token: makeJwt({ exp: exp + 5000 }),
      office_identity: 'org-7',
    })
    let refreshed = 0
    const store = makeStore({
      desktopPath,
      ownPath: ownPathIn(ownDir),
      refresh: async () => { refreshed += 1; return { accessToken: 'x' } },
    })
    const status = await store.status()
    expect(status).toEqual({
      state: 'signed-in',
      expiresAtMs: exp * 1000,
      refreshExpiresAtMs: (exp + 5000) * 1000,
      nickname: 'alice',
      identity: 'org-7',
      source: 'desktop',
    })
    expect(refreshed).toBe(0)
  })

  it('swallows filesystem errors into a signed-out reason instead of throwing', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const store = new RaccoonCredentialStore({
      variant: RACCOON_PRIMARY,
      desktopPath: join(desktopDir, 'auth.json'),
      ownPath: ownPathIn(ownDir),
      refresh: async () => ({ accessToken: 'x' }),
      fs: {
        readFile: (): Promise<never> => Promise.reject(denied),
        writeFile: (await import('node:fs/promises')).writeFile,
        stat: (await import('node:fs/promises')).stat,
        rm: (await import('node:fs/promises')).rm,
      },
    })
    const status = await store.status()
    expect(status.state).toBe('signed-out')
    expect(status.reason).toContain('EACCES')
  })

  it('removes the plugin copy, its lock, and the backup — never the app file', async () => {
    const desktopPath = writeDesktop({ access_token: 'opaque', refresh_token: 'R' })
    const ownPath = ownPathIn(ownDir)
    const lockPath = `${ownPath}.lock`
    const backupPath = join(ownDir, `${RACCOON_PRIMARY.ownFilename}-desktop-backup`)
    writeFileSync(ownPath, 'secret copy')
    writeFileSync(lockPath, '')
    writeFileSync(backupPath, 'secret backup')
    const before = readFileSync(desktopPath, 'utf8')
    const store = makeStore({ desktopPath, ownPath, refresh: async () => ({ accessToken: 'x' }) })
    await store.logout()
    expect(existsSync(ownPath)).toBe(false)
    expect(existsSync(lockPath)).toBe(false)
    expect(existsSync(backupPath)).toBe(false)
    expect(readFileSync(desktopPath, 'utf8')).toBe(before)
  })
})
