/**
 * Persisted reasoning-effort probe observations.
 *
 * A sweep spends the user's credit, so its result is worth keeping across
 * restarts — but keeping it *safely* needs three guards, all enforced here rather
 * than at call sites:
 *
 * - **Fingerprint.** A record is only reused while the catalog row it describes
 *   still looks the same. If the upstream changes a model's capabilities or its
 *   window, the old observation is about a different thing and is dropped.
 * - **Account.** Observations belong to whoever paid for them; serving one
 *   account's record to another would silently answer a question nobody asked.
 * - **Precedence.** A transient `unknown` (network blip, mid-sweep sign-out)
 *   never overwrites an earlier decisive `validating` / `non-validating`.
 *
 * Records also expire: an upstream that validated a field in April is a fact
 * about April.
 *
 * @module dsh-raccoon-connect/probe-store
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { RaccoonCatalogModel } from './catalog.ts'
import type { RaccoonProbeValidation } from './probe.ts'

/** How long an observation may be trusted. */
export const PROBE_RECORD_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** One stored observation. */
export interface RaccoonProbeRecord {
  fingerprint: string
  validation: RaccoonProbeValidation
  efforts: readonly string[]
  probedAtMs: number
  pluginVersion: string
  account: string
}

/** What a fingerprint is computed from; keep this list short and deliberate. */
export function probeFingerprint(model: RaccoonCatalogModel): string {
  const material = JSON.stringify({
    id: model.id,
    // The upstream's own tag, not {@link supportsVision}: this hash tracks *which
    // catalog row* an observation was paid for, and the tag is part of that row.
    // The resolved verdict is a local judgement that moves with plugin data and
    // with the user's configuration — folding it in would force a credit-spending
    // re-probe every time either of those changes.
    vision: model.tags.includes('vision'),
    contextWindow: model.contextWindow ?? 0,
    maxTokens: model.maxTokens ?? 0,
  })
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

function isRecord(value: unknown): value is RaccoonProbeRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['fingerprint'] === 'string'
    && typeof record['probedAtMs'] === 'number'
    && typeof record['account'] === 'string'
    && Array.isArray(record['efforts'])
    && (record['validation'] === 'validating' || record['validation'] === 'non-validating' || record['validation'] === 'unknown')
}

/**
 * File-backed store, one file per variant.
 *
 * The file holds `{version, records: {modelId: record}}`. A corrupt or
 * foreign-version file reads as empty rather than throwing: losing cached probe
 * answers is a smaller failure than refusing to start. Writes go through a temp
 * file and a rename, and a failure is swallowed for the same reason — the cache
 * is an optimization.
 */
export class RaccoonProbeStore {
  private records = new Map<string, RaccoonProbeRecord>()
  private loaded = false

  constructor(
    private readonly path: string = join(resolveDshHome(), '.raccoon-probe.json'),
    private readonly now: () => number = () => Date.now(),
  ) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return
      const document = parsed as Record<string, unknown>
      if (document['version'] !== 1) return
      const records = document['records']
      if (typeof records !== 'object' || records === null) return
      for (const [model, value] of Object.entries(records as Record<string, unknown>)) {
        if (isRecord(value)) this.records.set(model, value)
      }
    } catch {
      this.records = new Map()
    }
  }

  /** The live observation for one model, or undefined when none can be trusted. */
  get(account: string, model: string, fingerprint: string): RaccoonProbeRecord | undefined {
    this.load()
    const record = this.records.get(model)
    if (record === undefined) return undefined
    if (record.account !== account || record.fingerprint !== fingerprint) return undefined
    if (this.now() - record.probedAtMs > PROBE_RECORD_TTL_MS) return undefined
    return record
  }

  /**
   * Record one sweep's outcome for a model.
   *
   * Returns whether it was stored, so a caller can tell the user "nothing was
   * learned" without implying the write failed.
   */
  set(model: string, record: RaccoonProbeRecord): boolean {
    this.load()
    const previous = this.records.get(model)
    if (record.validation === 'unknown' && previous !== undefined && previous.validation !== 'unknown') {
      // Preserve the decisive answer; a failed re-probe is not evidence.
      return false
    }
    this.records.set(model, record)
    this.persist()
    return true
  }

  /** Newest-first view for display. */
  list(account?: string): { model: string, record: RaccoonProbeRecord }[] {
    this.load()
    return [...this.records.entries()]
      .filter(([, record]) => account === undefined || record.account === account)
      .map(([model, record]) => ({ model, record }))
      .sort((a, b) => b.record.probedAtMs - a.record.probedAtMs)
  }

  /** Drop every observation, e.g. when the account changes. */
  clear(): void {
    this.load()
    if (this.records.size === 0) return
    this.records = new Map()
    this.persist()
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const payload = `${JSON.stringify({ version: 1, records: Object.fromEntries(this.records) }, null, 2)}\n`
      const temp = `${this.path}.tmp`
      writeFileSync(temp, payload, { mode: 0o600 })
      renameSync(temp, this.path)
    } catch {
      // The probe cache must never be the reason a request fails.
    }
  }
}
