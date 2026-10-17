/**
 * The desktop client's own identity, as the 小浣熊 gateway expects to see it.
 *
 * The web renderer derives `X-Client-Platform` / `X-Client-Version` /
 * `X-Client-Device-ID` from its user-agent string; a headless plugin has no
 * user agent, so it reads the same facts from where the app leaves them:
 * `desktop-device-identity.json` in the app's Electron user-data directory, and
 * the install tree for the version. Every field is optional — the gateway adds
 * these headers when it has them and omits them otherwise, and a machine where
 * the app has never run must still be able to use a credential file it was
 * pointed at explicitly.
 *
 * @module dsh-raccoon-connect/client-identity
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The headers this plugin sends, once resolved. */
export interface RaccoonClientIdentity {
  platform: string
  version?: string
  deviceId?: string
  /** Electron user-data directory the credential was found in, for doctor. */
  userDataDir?: string
}

/** Candidate user-data directories per platform, in probe order. */
export function userDataCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']?.trim()
    return [appData === undefined || appData === '' ? join(home, 'AppData', 'Roaming') : appData]
      .map(root => join(root, 'office-raccoon'))
  }
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'office-raccoon')]
  }
  const xdg = process.env['XDG_CONFIG_HOME']?.trim()
  return [join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.config'), 'office-raccoon')]
}

/** The app's stable install id, or undefined when the app has never run here. */
function readDeviceId(userDataDir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(userDataDir, 'desktop-device-identity.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const value = (parsed as Record<string, unknown>)['clientDeviceId']
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Best-effort desktop version string.
 *
 * Windows keeps the Electron executable in a fixed install directory that is not
 * recorded in any config file, so the plugin reads `version` off the update
 * metadata the app itself maintains and gives up quietly otherwise — the header
 * is optional, and a wrong version is worse than no version at all.
 */
function readInstalledVersion(userDataDir: string): string | undefined {
  const candidates = [
    join(userDataDir, 'update-install-attempt.json'),
    process.env['RACCOON_APP_DIR'] === undefined ? '' : join(process.env['RACCOON_APP_DIR'], 'resources', 'app-update.yml'),
  ].filter(path => path !== '')
  for (const path of candidates) {
    try {
      const text = readFileSync(path, 'utf8')
      const json: unknown = path.endsWith('.json') ? JSON.parse(text) : undefined
      if (json !== undefined && typeof json === 'object' && json !== null) {
        for (const key of ['version', 'appVersion', 'targetVersion']) {
          const value = (json as Record<string, unknown>)[key]
          if (typeof value === 'string' && /^\d+\.\d+\.\d+/u.test(value)) return value
        }
      }
      // app-update.yml is YAML with a single useful `version:` line at most.
      const match = /^version:\s*"?(\d+\.\d+\.\d+[^"\n]*)"?/mu.exec(text)
      if (match !== null) return match[1]
    } catch {
      // Try the next candidate; absence is normal on machines without the app.
    }
  }
  return undefined
}

/**
 * Resolve the identity headers to send, reading disk at most once per process.
 *
 * Environment overrides win so a user on a non-standard install (portable app,
 * different profile, WSL) can pin the values without code changes:
 * `RACCOON_CLIENT_PLATFORM`, `RACCOON_CLIENT_VERSION`, `RACCOON_CLIENT_DEVICE_ID`.
 */
export function resolveClientIdentity(): RaccoonClientIdentity {
  const platform = process.env['RACCOON_CLIENT_PLATFORM']?.trim() || 'desktop'
  const overrideVersion = process.env['RACCOON_CLIENT_VERSION']?.trim()
  const overrideDevice = process.env['RACCOON_CLIENT_DEVICE_ID']?.trim()
  const userDataDir = userDataCandidates().find(dir => existsSync(dir))
  const resolved = {
    platform,
    ...(overrideVersion === undefined || overrideVersion === '' ? {} : { version: overrideVersion }),
    ...(overrideDevice === undefined || overrideDevice === '' ? {} : { deviceId: overrideDevice }),
    ...(userDataDir === undefined ? {} : { userDataDir }),
  }
  if (userDataDir === undefined) return resolved
  const version = resolved.version ?? readInstalledVersion(userDataDir)
  const deviceId = resolved.deviceId ?? readDeviceId(userDataDir)
  return {
    ...resolved,
    ...(version === undefined ? {} : { version }),
    ...(deviceId === undefined ? {} : { deviceId }),
  }
}

/** Where a credential file lives, resolved for diagnostics. */
export function describePath(path: string): string {
  try {
    return resolve(path)
  } catch {
    return dirname(path)
  }
}
