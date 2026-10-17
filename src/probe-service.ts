/**
 * Reasoning-effort probe orchestration: who may start a sweep, one at a time,
 * attributed to the account that paid for it.
 *
 * The protocol lives in `probe.ts`; this module owns the policy around it:
 *
 * - **Consent.** A sweep spends credit, so it runs only on an explicit user
 *   action, or when standing authorization is on in settings. Nothing here
 *   probes on boot, on catalog refresh, or on a model hover.
 * - **Serialization.** One sweep at a time per process: two parallel sweeps
 *   against a rate-limited gateway interleave their failures and make both
 *   results uninterpretable.
 * - **Attribution.** The account is captured before the sweep and re-checked
 *   before the write-back. Signing out mid-sweep means the answer belongs to a
 *   session that no longer exists, so it is dropped.
 */

import type { RaccoonCredentialStore } from './auth.ts'
import type { RaccoonCatalog } from './catalog.ts'
import { probeFingerprint } from './probe-store.ts'
import type { RaccoonProbeStore } from './probe-store.ts'
import { runProbeSweep } from './probe.ts'
import type { RaccoonProbeSend } from './probe.ts'
import type { RaccoonUpstreamClient } from './upstream.ts'
import type { RaccoonWebProbeModel } from './status-paths.ts'

/** Why a probe request did not run. */
export type RaccoonProbeRefusal = 'no-consent' | 'not-signed-in' | 'not-candidate'

/** Outcome of a probe request. */
export type RaccoonProbeResult = { ok: true } | { ok: false, reason: RaccoonProbeRefusal }

/** Constructor dependencies. */
export interface RaccoonProbeServiceOptions {
  catalog: RaccoonCatalog
  store: RaccoonCredentialStore
  upstream: RaccoonUpstreamClient
  probeStore: RaccoonProbeStore
  /** Standing authorization from settings. */
  consent: () => boolean
  pluginVersion: string
  /** Called after a record lands so the picker can pick up a new effort set. */
  notify: () => void
  now?: () => number
}

/** Orchestrates sweeps and holds their in-flight state. */
export class RaccoonProbeService {
  private readonly options: RaccoonProbeServiceOptions
  /** Tail of the queue; every sweep is chained onto it. */
  private tail: Promise<void> = Promise.resolve()
  /** The sweep currently running, if any. */
  private current: Promise<void> | undefined
  private runningCount = 0

  constructor(options: RaccoonProbeServiceOptions) {
    this.options = options
  }

  /** Whether a sweep is in flight right now. */
  isRunning(): boolean {
    return this.runningCount > 0
  }

  /**
   * Models the user could probe: every listed model without a decisive recorded
   * observation.
   *
   * The catalog's `reasoning` tag is tempting as a filter and is not one: it
   * labels the desktop app's routing presets, not the gateway's parameter
   * handling. Measured against the live catalog, `sn-glm-5-3-flash` carries no
   * `reasoning` tag and still streams `reasoning_content`, so narrowing by the
   * tag would hide a model the user may well want an effort control for. The
   * probe is the only evidence about `reasoning_effort` itself, so the only
   * exclusion here is "already answered".
   */
  async candidates(): Promise<{ id: string, label: string }[]> {
    const account = (await this.options.store.current())?.accountId
    if (account === undefined) return []
    const out: { id: string, label: string }[] = []
    for (const model of this.options.catalog.current()) {
      const record = this.options.probeStore.get(account, model.id, probeFingerprint(model))
      if (record !== undefined && record.validation !== 'unknown') continue
      out.push({ id: model.id, label: model.label === '' ? model.id : model.label })
    }
    return out
  }

  /** Recorded observations for the current account, newest first. */
  async results(): Promise<RaccoonWebProbeModel[]> {
    const account = (await this.options.store.current())?.accountId
    if (account === undefined) return []
    const catalog = this.options.catalog.current()
    return this.options.probeStore.list(account).map(({ model, record }) => {
      const info = catalog.find(entry => entry.id === model)
      return {
        id: model,
        name: info?.label ?? model,
        validation: record.validation,
        efforts: record.efforts,
        probedAt: record.probedAtMs,
      } satisfies RaccoonWebProbeModel
    })
  }

  /**
   * Probe one model, queued behind any sweep already running.
   *
   * `manual` is the button press. Automatic callers pass false and are refused
   * unless the user granted standing consent, which is what keeps a catalog
   * refresh or a status poll from silently spending credit.
   */
  async probe(modelId: string, manual: boolean): Promise<RaccoonProbeResult> {
    if (!manual && !this.options.consent()) return { ok: false, reason: 'no-consent' }
    const credential = await this.options.store.current()
    if (credential === undefined) return { ok: false, reason: 'not-signed-in' }
    const model = this.options.catalog.current().find(entry => entry.id === modelId)
    if (model === undefined) return { ok: false, reason: 'not-candidate' }

    const account = credential.accountId
    const fingerprint = probeFingerprint(model)
    const send = this.makeSender(modelId)
    const sweep = async (): Promise<void> => {
      this.runningCount += 1
      try {
        const outcome = await runProbeSweep(send)
        // Re-check attribution after the spend: signing out mid-sweep invalidates
        // the answer, and storing it would attribute one account's result to
        // whoever is next to read the file.
        const stillAccount = (await this.options.store.current())?.accountId
        if (stillAccount !== account) return
        this.options.probeStore.set(modelId, {
          fingerprint,
          validation: outcome.validation,
          efforts: outcome.efforts,
          probedAtMs: (this.options.now ?? Date.now)(),
          pluginVersion: this.options.pluginVersion,
          account,
        })
        this.options.notify()
      } finally {
        this.runningCount -= 1
        this.current = undefined
      }
    }
    // Chain onto the tail rather than onto a captured `current`: three presses
    // must serialize, and `current` alone would let two of them overlap.
    const chained = this.tail.then(sweep, sweep)
    this.tail = chained.catch(() => {})
    this.current = chained
    await this.tail
    return { ok: true }
  }

  /** Forget every recorded observation. */
  async clear(): Promise<void> {
    this.options.probeStore.clear()
    this.options.notify()
  }

  /** Bind one model id to a send function that always uses a fresh token. */
  private makeSender(modelId: string): RaccoonProbeSend {
    return async (effort?: string) => {
      const credential = await this.options.store.resolve()
      return await this.options.upstream.probeEffort(credential.accessToken, modelId, { ...(effort === undefined ? {} : { effort }) })
    }
  }
}
