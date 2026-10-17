/**
 * 小浣熊 credential resolution.
 *
 * The primary source is the credential file the desktop app already maintains
 * for its own local agent: `~/.box-agent/config/auth.json` (relocatable through
 * `BOX_AGENT_CONFIG_DIR`). Unlike the WorkBuddy-style "read the desktop file,
 * never write it" design, 小浣熊's refresh token is **single-use**: refreshing
 * rotates both tokens server-side, so a client that refreshes without writing
 * the pair back would log the desktop app out at its next refresh. This store
 * therefore (a) prefers re-reading the desktop file over refreshing whenever it
 * still holds a live token, and (b) when it does have to refresh, writes the
 * rotated pair back into the desktop file in the app's own shape, keeping a
 * one-time backup of what it replaced.
 *
 * A plugin-owned copy under `$DSH_HOME` still exists for the case where the
 * desktop file is absent or read-only; the fresher of the two wins.
 *
 * @module dsh-raccoon-connect/auth
 */

import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { RaccoonVariant } from './variants.ts'

/** Refresh outcome as reported by the upstream. */
export interface RaccoonRefreshOutcome {
  accessToken: string
  /**
   * The rotated refresh token. 小浣熊 always rotates it together with the
   * access token; an absent value means the upstream did not send one and the
   * caller must keep the previous token rather than assume it stayed valid.
   */
  refreshToken?: string
}

/** Normalized 小浣熊 credential, timestamps in epoch milliseconds. */
export interface RaccoonCredential {
  accessToken: string
  refreshToken: string
  /** Access-token expiry from its JWT `exp`; 0 when the token is unparsable. */
  expiresAtMs: number
  /** Refresh-token expiry from its JWT `exp`, when available. */
  refreshExpiresAtMs?: number
  /** Stable per-account key used to scope saved catalogs and probe records. */
  accountId: string
  /** Nickname from the access token's `name` claim. */
  nickname?: string
  /** `personal`, or the organization identity the app stored. */
  identity?: string
  orgName?: string
  orgRole?: string
  /** Which storage the credential was read from. */
  source: 'desktop' | 'dsh'
}

/** Read-only sign-in summary for status and doctor output. */
export interface RaccoonAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  nickname?: string
  identity?: string
  orgName?: string
  source?: 'desktop' | 'dsh'
  /**
   * Why no credential is usable, when that is diagnosable rather than simply
   * "nobody signed in" — an exhausted refresh token being the case that matters
   * most, because the fix is to open the desktop app once.
   */
  reason?: string
}

/** Constructor options; only {@link refresh} is required. */
export interface RaccoonStoreOptions {
  variant: RaccoonVariant
  /** Explicit desktop credential path, overriding env and the default. */
  desktopPath?: string
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string
  /** Performs the upstream token refresh. */
  refresh: (refreshToken: string) => Promise<RaccoonRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
  /** Filesystem surface, injectable for tests. */
  fs?: Pick<typeof import('node:fs/promises'), 'readFile' | 'writeFile' | 'stat' | 'rm'>
  /** Whether rotated tokens are written back to the desktop file; default true. */
  writeBackDesktop?: boolean
}

/** The keys the desktop app itself writes, in its own order. */
const DESKTOP_TOKEN_KEYS = ['access_token', 'refresh_token', 'office_identity', 'office_org_name', 'office_org_role'] as const

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  credential: RaccoonCredential
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Candidate locations for the desktop credential file, in probe order.
 *
 * The app resolves its own directory as `BOX_AGENT_CONFIG_DIR` or
 * `~/.box-agent/config`, so the plugin mirrors that rather than guessing at
 * per-platform application-data roots. An explicit setting or the variant's env
 * var short-circuits the list to that one path.
 */
export function desktopAuthCandidatesFor(variant: RaccoonVariant): string[] {
  const fromEnv = process.env[variant.env]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return [fromEnv]
  const configured = process.env[variant.configDirEnv]?.trim()
  const dir = configured !== undefined && configured !== ''
    ? configured
    : join(homedir(), ...variant.configDirRel.split('/'))
  return [join(dir, variant.desktopFilename)]
}

/**
 * Decode the JWT claims the credential files carry.
 *
 * The desktop document stores no expiry field of its own, so lifetime and
 * identity come from the tokens themselves: `exp`, `name`, `sid`, `iss`.
 * Signature verification is not the plugin's job — it forwards the token and the
 * upstream decides. Malformed or non-JWT values yield an empty claim set, which
 * callers treat as "expiry unknown" rather than "expired".
 */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const segment = token.split('.')[1]
  if (segment === undefined || segment === '') return {}
  try {
    const padded = segment.replace(/-/gu, '+').replace(/_/gu, '/')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(decoded)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** `exp` claim in epoch milliseconds, or 0 when absent/unparsable. */
function expiryFromClaims(claims: Record<string, unknown>): number {
  const exp = claims['exp']
  return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0
}

/**
 * The account key a credential belongs to.
 *
 * `sid` changes at every login, so it cannot scope anything; `iss` plus the
 * `name` claim is the stable pair the observed tokens provide. A credential with
 * neither falls back to a hash of the access token so two different unknown
 * accounts still cannot collide into one saved catalog.
 */
function accountKeyOf(claims: Record<string, unknown>, accessToken: string): string {
  const iss = optionalString(claims['iss']) ?? ''
  const name = optionalString(claims['name']) ?? ''
  if (iss !== '' || name !== '') return `${iss}:${name}`
  if (accessToken === '') return ''
  let hash = 0
  for (let index = 0; index < accessToken.length; index += 1) {
    hash = (hash * 31 + accessToken.charCodeAt(index)) | 0
  }
  return `token:${(hash >>> 0).toString(16)}`
}

/** Build a credential from a parsed desktop/own document. */
function credentialFrom(
  fields: {
    accessToken: string
    refreshToken: string
    identity?: string
    orgName?: string
    orgRole?: string
  },
  source: RaccoonCredential['source'],
): RaccoonCredential | undefined {
  if (fields.accessToken === '') return undefined
  const access = decodeJwtClaims(fields.accessToken)
  const refresh = fields.refreshToken === '' ? {} : decodeJwtClaims(fields.refreshToken)
  const refreshExpiresAtMs = expiryFromClaims(refresh)
  const nickname = optionalString(access['name'])
  return {
    accessToken: fields.accessToken,
    refreshToken: fields.refreshToken,
    expiresAtMs: expiryFromClaims(access),
    ...(refreshExpiresAtMs > 0 ? { refreshExpiresAtMs } : {}),
    accountId: accountKeyOf(access, fields.accessToken),
    ...(nickname === undefined ? {} : { nickname }),
    ...(fields.identity === undefined ? {} : { identity: fields.identity }),
    ...(fields.orgName === undefined ? {} : { orgName: fields.orgName }),
    ...(fields.orgRole === undefined ? {} : { orgRole: fields.orgRole }),
    source,
  }
}

/**
 * Parse the desktop app's credential document.
 *
 * Accepts the app's own key set and the two aliases its reader accepts for the
 * access token (`token`, `auth_token`), so an older or alternate build's file
 * still works. Returns undefined when the document carries no access token.
 */
export function parseDesktopAuth(text: string): RaccoonCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  const accessToken = optionalString(document['access_token']) ?? optionalString(document['token']) ?? optionalString(document['auth_token']) ?? ''
  const identity = optionalString(document['office_identity'])
  const orgName = optionalString(document['office_org_name'])
  const orgRole = optionalString(document['office_org_role'])
  return credentialFrom({
    accessToken,
    refreshToken: optionalString(document['refresh_token']) ?? '',
    ...(identity === undefined ? {} : { identity }),
    ...(orgName === undefined ? {} : { orgName }),
    ...(orgRole === undefined ? {} : { orgRole }),
  }, 'desktop')
}

/** Serialize the plugin-owned copy. */
function ownDocument(credential: RaccoonCredential): OwnDocument {
  return { version: OWN_FORMAT_VERSION, credential }
}

/**
 * Parse the plugin-owned copy; other versions and shapes are rejected.
 *
 * Deliberately a separate reader from {@link parseDesktopAuth}: the copy stores
 * the normalized credential (camelCase, `expiresAtMs`, `accountId`), and
 * round-tripping it through the desktop parser would lose the identity fields
 * and recompute the expiry on every read.
 */
function parseOwnDocument(text: string): RaccoonCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document['version'] !== OWN_FORMAT_VERSION) return undefined
  if (typeof document['credential'] !== 'object' || document['credential'] === null) return undefined
  const stored = document['credential'] as Record<string, unknown>
  const accessToken = optionalString(stored['accessToken']) ?? ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof stored['expiresAtMs'] === 'number' ? stored['expiresAtMs'] : 0
  const refreshExpiresAtMs = typeof stored['refreshExpiresAtMs'] === 'number' ? stored['refreshExpiresAtMs'] : undefined
  const nickname = optionalString(stored['nickname'])
  const identity = optionalString(stored['identity'])
  const orgName = optionalString(stored['orgName'])
  const orgRole = optionalString(stored['orgRole'])
  const accountId = optionalString(stored['accountId']) ?? accountKeyOf(decodeJwtClaims(accessToken), accessToken)
  return {
    accessToken,
    refreshToken: optionalString(stored['refreshToken']) ?? '',
    expiresAtMs,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    accountId,
    ...(nickname === undefined ? {} : { nickname }),
    ...(identity === undefined ? {} : { identity }),
    ...(orgName === undefined ? {} : { orgName }),
    ...(orgRole === undefined ? {} : { orgRole }),
    source: 'dsh',
  }
}

/**
 * Credential store with demand-driven, write-back refresh.
 *
 * Refresh policy: re-read the desktop file on every resolution (the app does
 * not cache it either), use a live access token as-is, and only refresh inside
 * the margin. A failed refresh still returns a not-yet-expired token, so an
 * unreachable refresh endpoint cannot take down a working session.
 */
export class RaccoonCredentialStore {
  private readonly variant: RaccoonVariant
  private readonly refresh: RaccoonStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly ownPath: string
  private readonly fs: RaccoonStoreOptions['fs']
  private readonly writeBackDesktop: boolean
  private desktopPathOverride: string | undefined
  private inflight: Promise<RaccoonCredential> | undefined
  /** Desktop document last read, so a write-back can keep its other fields. */
  private desktopDocument: Record<string, unknown> | undefined
  /** Whether the pre-refresh backup of the desktop file has been taken. */
  private backedUp = false

  constructor(options: RaccoonStoreOptions) {
    this.variant = options.variant
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.ownPath = options.ownPath ?? join(resolveDshHome(), options.variant.ownFilename)
    this.fs = options.fs
    this.writeBackDesktop = options.writeBackDesktop ?? true
    this.desktopPathOverride = options.desktopPath
  }

  private candidates(): string[] {
    if (this.desktopPathOverride !== undefined) return [this.desktopPathOverride]
    return desktopAuthCandidatesFor(this.variant)
  }

  /** The desktop credential path in effect, for diagnostics. */
  desktopAuthPath(): string {
    return this.candidates()[0] ?? ''
  }

  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string {
    return this.ownPath
  }

  /** Repoint the desktop file; a settings change applies on the next read. */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
    this.desktopDocument = undefined
  }

  /** Read the freshest stored credential without refreshing anything. */
  async current(): Promise<RaccoonCredential | undefined> {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    // Identity beats expiry. The copy is written by this plugin's own refreshes,
    // so after the user switches accounts in the desktop app it still belongs to
    // the previous account and may well outlive the new one. Preferring it by
    // timestamp would keep answering as the wrong user.
    if (desktop.accountId !== own.accountId) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh — which matters more
   * here than in a read-only design, because two concurrent refreshes would burn
   * one single-use refresh token and strand the other caller.
   */
  async resolve(): Promise<RaccoonCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      throw new Error(
        `raccoon: no signed-in ${this.variant.appName} account found; sign in once in the ${this.variant.appName} desktop app`
        + ` (expected ${this.desktopAuthPath()} or ${this.variant.env})`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status(): Promise<RaccoonAuthStatus> {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...(credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs }),
        ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
        ...(credential.identity === undefined ? {} : { identity: credential.identity }),
        ...(credential.orgName === undefined ? {} : { orgName: credential.orgName }),
        source: credential.source,
      }
    } catch (error: unknown) {
      return { state: 'signed-out', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Remove the plugin-owned copy and the desktop backup it wrote.
   *
   * The desktop credential file itself is never deleted: it belongs to the app,
   * and removing it would sign the user out of 小浣熊 as a side effect of a
   * plugin cleanup.
   */
  async logout(): Promise<void> {
    await this.remove(this.ownPath)
    await this.remove(`${this.ownPath}.lock`)
    await this.remove(this.backupPath())
  }

  private backupPath(): string {
    return join(dirname(this.ownPath), `${this.variant.ownFilename}-desktop-backup`)
  }

  private needsRefresh(credential: RaccoonCredential): boolean {
    if (credential.expiresAtMs <= 0) return false
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  private async refreshNow(credential: RaccoonCredential): Promise<RaccoonCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        'raccoon: access token expired and no refresh token is stored;'
        + ` sign in again in the ${this.variant.appName} desktop app`,
      )
    }
    try {
      return await this.refreshOnce(credential)
    } catch (error: unknown) {
      // A single-use token refused as "reused" usually means the desktop app
      // refreshed after we read the file. Re-read once and use what it left.
      if (this.isConflict(error)) {
        const reread = await this.readDesktop()
        if (reread !== undefined && reread.accessToken !== credential.accessToken && !this.needsRefresh(reread)) {
          return reread
        }
        if (reread !== undefined && reread.refreshToken !== '' && reread.refreshToken !== credential.refreshToken) {
          return await this.refreshOnce(reread)
        }
      }
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `raccoon: token refresh failed and the access token is expired (${this.redact(error, credential)});`
        + ` open the ${this.variant.appName} desktop app once to sign in again`,
      )
    }
  }

  private async refreshOnce(credential: RaccoonCredential): Promise<RaccoonCredential> {
    const outcome = await this.refresh(credential.refreshToken)
    const refreshed: RaccoonCredential = credentialFrom({
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken ?? credential.refreshToken,
      ...(credential.identity === undefined ? {} : { identity: credential.identity }),
      ...(credential.orgName === undefined ? {} : { orgName: credential.orgName }),
      ...(credential.orgRole === undefined ? {} : { orgRole: credential.orgRole }),
    }, 'dsh') ?? { ...credential, accessToken: outcome.accessToken, source: 'dsh' }
    await this.saveOwn(refreshed)
    if (this.writeBackDesktop) await this.saveDesktop(refreshed)
    return refreshed
  }

  private isConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('refresh_conflict') || message.includes('200822')
  }

  /** Error text with the presented credential stripped out. */
  private redact(error: unknown, credential: RaccoonCredential): string {
    let message = error instanceof Error ? error.message : String(error)
    for (const secret of [credential.accessToken, credential.refreshToken]) {
      if (secret !== '') message = message.split(secret).join('<redacted>')
    }
    return message
  }

  private async saveOwn(credential: RaccoonCredential): Promise<void> {
    await withFileLock(this.ownPath, async () => {
      await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  /**
   * Write the rotated pair back where the app reads it.
   *
   * The rewrite keeps the document's other fields and the app's own key order,
   * and mirrors its atomic temp-file-plus-rename write with mode 0600, so the
   * app cannot observe a half-written file. The first overwrite in a process
   * also leaves a backup of the replaced document next to the plugin's copy:
   * if a write-back ever strands the app's session, that file is the rollback.
   */
  private async saveDesktop(credential: RaccoonCredential): Promise<void> {
    for (const path of this.candidates()) {
      const existing = this.desktopDocument ?? undefined
      try {
        if (!this.backedUp) await this.backupDesktop(path)
        const document: Record<string, unknown> = { ...(existing ?? {}) }
        for (const key of DESKTOP_TOKEN_KEYS) delete document[key]
        document['access_token'] = credential.accessToken
        document['refresh_token'] = credential.refreshToken
        if (credential.identity !== undefined) document['office_identity'] = credential.identity
        if (credential.orgName !== undefined) document['office_org_name'] = credential.orgName
        if (credential.orgRole !== undefined) document['office_org_role'] = credential.orgRole
        const payload = `${JSON.stringify(this.orderedDesktop(document), null, 2)}\n`
        await this.writeAtomically(path, payload)
        this.desktopDocument = document
        return
      } catch {
        // An unwritable desktop file (read-only mount, another user's profile)
        // is not fatal: the plugin's own copy carries the session.
        return
      }
    }
  }

  /** The app's key order first, anything the user's file had afterwards. */
  private orderedDesktop(document: Record<string, unknown>): Record<string, unknown> {
    const ordered: Record<string, unknown> = {}
    for (const key of DESKTOP_TOKEN_KEYS) {
      if (key in document) ordered[key] = document[key]
    }
    for (const [key, value] of Object.entries(document)) {
      if (!(key in ordered)) ordered[key] = value
    }
    return ordered
  }

  private async backupDesktop(path: string): Promise<void> {
    this.backedUp = true
    try {
      const text = await this.read(path)
      if (text === undefined) return
      await writeFileAtomic(this.backupPath(), text, { mode: 0o600, dirMode: 0o700 })
    } catch {
      // Best effort; a failed backup never blocks a needed refresh.
    }
  }

  private async writeAtomically(path: string, payload: string): Promise<void> {
    const temp = `${path}.${process.pid}.tmp`
    try {
      await (this.fs?.writeFile ?? writeFile)(temp, payload, { encoding: 'utf8', mode: 0o600 })
      const { rename } = await import('node:fs/promises')
      await rename(temp, path)
    } catch (error: unknown) {
      await this.remove(temp)
      throw error
    }
  }

  private async remove(path: string): Promise<void> {
    try {
      await (this.fs?.rm ?? rm)(path, { force: true })
    } catch {
      // Nothing to remove.
    }
  }

  private async read(path: string): Promise<string | undefined> {
    try {
      return await (this.fs?.readFile ?? readFile)(path, 'utf8')
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  /**
   * Read the first desktop candidate that exists.
   *
   * Only an absent file falls through to the next candidate; a file that is
   * present but unparsable is authoritative, so a broken file is never silently
   * skipped in favour of a stale older one. The parsed document is kept so a
   * later write-back can preserve the fields this plugin does not own.
   */
  private async readDesktop(): Promise<RaccoonCredential | undefined> {
    for (const path of this.candidates()) {
      const text = await this.read(path)
      if (text === undefined) continue
      try {
        this.desktopDocument = JSON.parse(text) as Record<string, unknown>
      } catch {
        this.desktopDocument = undefined
      }
      return parseDesktopAuth(text)
    }
    this.desktopDocument = undefined
    return undefined
  }

  private async readOwn(): Promise<RaccoonCredential | undefined> {
    try {
      const text = await this.read(this.ownPath)
      return text === undefined ? undefined : parseOwnDocument(text)
    } catch {
      return undefined
    }
  }

  /** Whether the desktop credential file exists as a regular file. */
  async desktopFilePresent(): Promise<boolean> {
    for (const path of this.candidates()) {
      try {
        if ((await (this.fs?.stat ?? stat)(path)).isFile()) return true
      } catch {
        // Absent or not a regular file — the next candidate decides.
      }
    }
    return false
  }
}
