#!/usr/bin/env node
/**
 * The plugin's command line: `status`, `doctor`, `logout`.
 *
 * Reached through the harness rather than directly, so it runs inside the
 * profile's dependency closure:
 *
 * ```
 * dsh plugin --profile web exec dsh-raccoon-connect status
 * ```
 *
 * which is the harness forwarding `exec …` to `pnpm exec` in the profile
 * directory. That matters for one reason: this file must not import cordis or
 * any harness service. It is a plain node script, and the moment it needs a
 * running host it stops being able to answer "why is the provider not showing up"
 * in exactly the situation where the host is broken.
 *
 * Both read-only commands deliberately use `store.current()` and never
 * `resolve()`. Refreshing a 小浣熊 token rotates a *single-use* refresh token and
 * writes the pair back to the desktop app's file; a command someone typed to
 * "just look" must not be the thing that changes their sign-in state.
 */

import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RaccoonCredentialStore } from './auth.ts'
import { FALLBACK_CATALOG } from './catalog.ts'
import { resolveClientIdentity, userDataCandidates } from './client-identity.ts'
import { hostHeartbeatPath, hostStatus, readHostHeartbeat } from './heartbeat.ts'
import { RaccoonProbeStore } from './probe-store.ts'
import { RaccoonUpstreamClient } from './upstream.ts'
import { ALL_VARIANTS, variantFor } from './variants.ts'
import { RACCOON_CONNECT_VERSION } from './version.ts'

/** Machine-readable status output. */
export interface RaccoonCliStatus {
  pluginVersion: string
  provider: string
  state: 'signed-in' | 'signed-out'
  reason?: string
  nickname?: string
  identity?: string
  orgName?: string
  source?: 'desktop' | 'dsh'
  expiresAt?: number
  refreshExpiresAt?: number
  expiresInSec?: number
  desktopAuthPath: string
  desktopFilePresent: boolean
  ownAuthPath: string
  host: 'running' | 'stale' | 'not-started'
  points?: { total?: number, plan?: string, note?: string }
  pointsError?: string
  /** Anything the message would otherwise leak into a terminal scrollback. */
  notes: string[]
}

/** A recognized command line. */
export interface RaccoonCliArgs {
  command: 'status' | 'doctor' | 'logout' | 'help'
  json: boolean
  provider: string
}

/** What {@link run} returns: an exit code plus the lines it printed. */
export interface RaccoonCliResult {
  code: number
  lines: string[]
  status?: RaccoonCliStatus
}

/** Strip anything shaped like a token from a message before it reaches a terminal. */
export function safeMessage(value: string): string {
  return value
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/gu, '<token>')
    .replace(/(access_token|refresh_token)["'\s:=]+[A-Za-z0-9._-]{12,}/giu, '$1=<token>')
}

/** Parse argv. Unknown flags are reported rather than ignored. */
export function parseArgs(argv: readonly string[]): RaccoonCliArgs | { error: string } {
  const positionals: string[] = []
  let json = false
  let provider = ALL_VARIANTS[0]!.id
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--provider') {
      const next = argv[index + 1]
      if (next === undefined) return { error: '--provider needs a value' }
      provider = next
      index += 1
      continue
    }
    if (arg.startsWith('--provider=')) {
      provider = arg.slice('--provider='.length)
      continue
    }
    if (arg.startsWith('-')) return { error: `unknown option ${arg}` }
    positionals.push(arg)
  }
  const requested = positionals[0] ?? 'status'
  if (requested !== 'status' && requested !== 'doctor' && requested !== 'logout' && requested !== 'help') {
    return { error: `unknown command ${requested}` }
  }
  if (variantFor(provider) === undefined) return { error: `unknown provider ${provider}` }
  return { command: requested, json, provider }
}

function buildStore(provider: string): { store: RaccoonCredentialStore, client: RaccoonUpstreamClient } {
  const variant = variantFor(provider) ?? ALL_VARIANTS[0]!
  const client = new RaccoonUpstreamClient({ variant, identity: resolveClientIdentity })
  const store = new RaccoonCredentialStore({ variant, refresh: token => client.refresh(token) })
  return { store, client }
}

/**
 * Collect everything the read-only commands report.
 *
 * Never refreshes, never spends a request unless the user asked for `status`
 * (which reads the balance) and the token is still live.
 */
export async function collectStatus(provider: string, options: { withPoints?: boolean } = {}): Promise<RaccoonCliStatus> {
  const variant = variantFor(provider) ?? ALL_VARIANTS[0]!
  const { store, client } = buildStore(variant.id)
  const summary = await store.status()
  const notes: string[] = []
  const desktopPresent = await store.desktopFilePresent()
  if (!desktopPresent) {
    notes.push(`未发现小浣熊登录文件：${store.desktopAuthPath()}（可用 ${variant.env} 指定实际位置）`)
  }
  const status: RaccoonCliStatus = {
    pluginVersion: RACCOON_CONNECT_VERSION,
    provider: variant.id,
    state: summary.state,
    ...(summary.reason === undefined ? {} : { reason: summary.reason }),
    ...(summary.nickname === undefined ? {} : { nickname: summary.nickname }),
    ...(summary.identity === undefined ? {} : { identity: summary.identity }),
    ...(summary.orgName === undefined ? {} : { orgName: summary.orgName }),
    ...(summary.source === undefined ? {} : { source: summary.source }),
    ...(summary.expiresAtMs === undefined ? {} : { expiresAt: summary.expiresAtMs }),
    ...(summary.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: summary.refreshExpiresAtMs }),
    desktopAuthPath: store.desktopAuthPath(),
    desktopFilePresent: desktopPresent,
    ownAuthPath: store.ownAuthPath(),
    host: hostStatus(),
    notes,
  }
  if (status.expiresAt !== undefined) {
    status.expiresInSec = Math.round((status.expiresAt - Date.now()) / 1000)
    if (status.expiresInSec <= 0) notes.push('访问令牌已过期：打开一次商汤小浣熊重新登录，或由插件在下一次请求时自动续期')
  }
  if (options.withPoints === true && summary.state === 'signed-in') {
    const current = await store.current()
    if (current !== undefined && current.expiresAtMs > Date.now()) {
      try {
        status.points = await client.fetchBalance(current.accessToken)
      } catch (error: unknown) {
        status.pointsError = safeMessage(error instanceof Error ? error.message : String(error))
      }
    } else {
      notes.push('令牌不在有效期内，未查询积分余额')
    }
  }
  return status
}

/** Human-readable rendering of a collected status. */
export function renderStatus(status: RaccoonCliStatus): string[] {
  const lines = [
    `插件版本    dsh-raccoon-connect ${status.pluginVersion}`,
    `提供商      ${status.provider}`,
    `登录态      ${status.state === 'signed-in' ? '已登录' : '未登录'}${status.reason === undefined ? '' : `（${safeMessage(status.reason)}）`}`,
  ]
  if (status.nickname !== undefined) lines.push(`账号        ${status.nickname}`)
  if (status.identity !== undefined) lines.push(`身份        ${status.identity}${status.orgName === undefined ? '' : ` / ${status.orgName}`}`)
  if (status.source !== undefined) lines.push(`凭据来源    ${status.source === 'desktop' ? '小浣熊 App 文件' : '插件自有副本'}`)
  if (status.expiresAt !== undefined) {
    lines.push(`访问令牌    至 ${new Date(status.expiresAt).toLocaleString()}${status.expiresInSec === undefined ? '' : `（剩余 ${Math.max(0, Math.round(status.expiresInSec / 60))} 分钟）`}`)
  }
  if (status.refreshExpiresAt !== undefined) lines.push(`刷新令牌    至 ${new Date(status.refreshExpiresAt).toLocaleString()}`)
  if (status.points !== undefined) {
    const parts = [status.points.total === undefined ? '' : `合计 ${status.points.total}`, status.points.plan ?? '', status.points.note ?? ''].filter(part => part !== '')
    lines.push(`积分        ${parts.length === 0 ? '（上游未给出可读字段）' : parts.join(' · ')}`)
  }
  if (status.pointsError !== undefined) lines.push(`积分查询    失败：${status.pointsError}`)
  lines.push(`App 凭据    ${status.desktopFilePresent ? '存在' : '缺失'}  ${status.desktopAuthPath}`)
  lines.push(`插件副本    ${status.ownAuthPath}`)
  lines.push(`宿主状态    ${status.host === 'running' ? '有 DSH 进程已注册该 provider' : status.host === 'stale' ? '心跳残留（宿主已退出）' : '当前没有运行中的 DSH 注册'}`)
  for (const note of status.notes) lines.push(`提示        ${note}`)
  return lines
}

/** Extra `doctor` output: paths, heartbeat contents, roster size, probe cache. */
export function renderDoctor(status: RaccoonCliStatus): string[] {
  const lines = renderStatus(status)
  const probes = probeCount()
  lines.push('')
  lines.push(`探测缓存    ${probes > 0 ? `${probes} 条` : '无'}`)
  const heartbeat = readHostHeartbeat()
  lines.push(`心跳文件    ${heartbeat === undefined ? `${hostHeartbeatPath()}（无）` : `pid ${heartbeat.pid} @ ${new Date(heartbeat.registeredAt).toLocaleString()}`}`)
  const identity = resolveClientIdentity()
  lines.push(`客户端标识  platform=${identity.platform}${identity.version === undefined ? '' : ` version=${identity.version}`}${identity.deviceId === undefined ? '' : ` device=${identity.deviceId.slice(0, 8)}…`}`)
  lines.push(`用户数据目录候选 ${userDataCandidates().join(', ')}${existsSync(status.desktopAuthPath) ? '' : '（未找到 App 目录）'}`)
  lines.push(`内置兜底名册 ${FALLBACK_CATALOG.length} 个模型（仅在网络/登录不可用时展示）`)
  return lines
}

function probeCount(): number {
  try {
    const store = new RaccoonProbeStore()
    return store.list().length
  } catch {
    return 0
  }
}

/** Usage text, printed by `help` and on any parse error. */
export function usage(): string[] {
  return [
    '用法：dsh plugin --profile <profile> exec dsh-raccoon-connect <command> [options]',
    '',
    '命令：',
    '  status     登录态、令牌有效期与剩余积分（--json 输出机器可读）',
    '  doctor     诊断：路径、心跳、客户端标识、兜底名册',
    '  logout     只删除插件自留的凭据副本，不动 App 自己的文件',
    '',
    '选项：',
    `  --provider <id>   目标产品，默认 ${ALL_VARIANTS[0]!.id}（当前仅此一个）`,
    '  --json            机器可读输出',
  ]
}

/**
 * Run the CLI.
 *
 * @param argv - arguments after the command name.
 * @param output - injected so tests (and a future JSON-only caller) capture lines
 *   instead of watching a process write to a terminal.
 */
export async function run(
  argv: readonly string[],
  output: { log: (line: string) => void, error: (line: string) => void } = { log: line => console.log(line), error: line => console.error(line) },
): Promise<number> {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    output.error(parsed.error)
    for (const line of usage()) output.error(line)
    return 2
  }
  if (parsed.command === 'help') {
    for (const line of usage()) output.log(line)
    return 0
  }
  if (parsed.command === 'logout') {
    const { store } = buildStore(parsed.provider)
    await store.logout()
    output.log('已删除插件自留的凭据副本与其备份；商汤小浣熊 App 自己的登录文件未被改动，仍然有效。')
    return 0
  }
  try {
    const status = await collectStatus(parsed.provider, { withPoints: parsed.command === 'status' })
    if (parsed.json) {
      output.log(JSON.stringify({ ...status, reason: status.reason === undefined ? undefined : safeMessage(status.reason) }))
    } else {
      for (const line of (parsed.command === 'doctor' ? renderDoctor : renderStatus)(status)) output.log(line)
    }
    // `doctor` exits non-zero when nothing usable was found, so it can gate a script.
    if (parsed.command === 'doctor') return status.state === 'signed-in' && status.desktopFilePresent ? 0 : 1
    return 0
  } catch (error: unknown) {
    output.error(safeMessage(error instanceof Error ? error.stack ?? error.message : String(error)))
    return 1
  }
}

/**
 * Self-run only when this file *is* the executed script.
 *
 * The comparison is against the realpath because the profile installs this file
 * through a symlink, and a plain string compare would then be false for the one
 * invocation that needs it — while a loose check would let the harness import the
 * module and immediately print usage.
 */
const invoked = process.argv[1] === undefined ? '' : realpathSync(process.argv[1])
if (invoked !== '' && fileURLToPath(import.meta.url) === invoked) {
  void run(process.argv.slice(2)).then(code => {
    process.exitCode = code
  })
}
