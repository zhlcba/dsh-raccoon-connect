/**
 * The reasoning-effort probe protocol: what a single sweep does, in what order,
 * and what each answer is allowed to mean.
 *
 * The upstream catalog declares no effort vocabulary for 小浣熊's models, and a
 * request returning HTTP 200 proves nothing about whether the gateway *honored*
 * `reasoning_effort` — a server that ignores an unknown value answers normally.
 * So capability is established by experiment, and the experiment has to rule out
 * being meaningless before its per-level answers count:
 *
 * 1. **baseline** — no `reasoning_effort` at all. If that fails, nothing was
 *    learned about the parameter and the whole run is `unknown`.
 * 2. **sentinel** — a value that cannot exist (`probe_sentinel_<24 hex>`). If the
 *    upstream *accepts* it, the upstream does not validate the field, so every
 *    per-level answer it could give would be a false positive: the run stops as
 *    `non-validating` and yields no picker control.
 * 3. **levels** — only once validation is proven, each canonical level is tested
 *    for acceptance.
 *
 * Any answer that is neither "accepted" nor "a decisive refusal" voids the run to
 * `unknown`: a sweep never guesses from silence. Probing spends credit, so it is
 * only ever started by an explicit user action, and a transient `unknown` must
 * not overwrite an earlier decisive record — that rule lives in the store.
 *
 * @module dsh-raccoon-connect/probe
 */

import { randomBytes } from 'node:crypto'
import type { RaccoonProbeAttempt } from './upstream.ts'

/** What a sweep concluded about the upstream's parameter handling. */
export type RaccoonProbeValidation = 'validating' | 'non-validating' | 'unknown'

/** Outcome of one sweep. */
export interface RaccoonProbeOutcome {
  validation: RaccoonProbeValidation
  /** Accepted levels; non-empty only for a `validating` upstream. */
  efforts: readonly string[]
}

/** Levels worth testing, in the order the picker shows them. */
export const PROBE_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Business codes and phrases the 小浣熊 gateway answers with when it rejects a
 * request parameter.
 *
 * The gateway reports parameter problems as `100002 / params_invalid_error`
 * (observed while probing the refresh endpoint with a misspelled field name —
 * see `docs/upstream-protocol.md` §2), which is the decisive "this upstream
 * validates what it is given" signal. Anything else that arrives as a 400 is
 * treated as silence, not as a refusal, because an unrelated validation failure
 * would otherwise be read as proof the field is checked.
 */
const REFUSAL_CODES = new Set(['100002'])
const REFUSAL_PHRASES = ['params_invalid', 'invalid_reasoning_effort', 'reasoning_effort']

/** Whether one attempt is a decisive refusal of the submitted value. */
export function isRefusal(attempt: RaccoonProbeAttempt): boolean {
  if (attempt.status !== 400) return false
  if (attempt.errorCode !== undefined && REFUSAL_CODES.has(attempt.errorCode)) return true
  const message = (attempt.message ?? '').toLowerCase()
  return REFUSAL_PHRASES.some(phrase => message.includes(phrase.toLowerCase()))
}

/** Whether an attempt proves the value was accepted: 200 *and* streaming began. */
export function isAccepted(attempt: RaccoonProbeAttempt): boolean {
  return attempt.status === 200 && attempt.streamed
}

/** A value no real model could accept, used to test whether the upstream checks. */
export function sentinelValue(randomHex: () => string): string {
  return `probe_sentinel_${randomHex()}`
}

/** One probe request, already bound to a model and credential. */
export type RaccoonProbeSend = (effort?: string) => Promise<RaccoonProbeAttempt>

/**
 * Run one sweep.
 *
 * The order is the protocol, not an optimization: skipping the sentinel because a
 * level "looked fine" is precisely how a non-validating upstream ends up
 * advertising five levels it ignores.
 */
export async function runProbeSweep(
  send: RaccoonProbeSend,
  options: {
    /** Levels to test; defaults to {@link PROBE_LEVELS}. */
    levels?: readonly string[]
    /** Abort between levels when the user closes the card or signs out. */
    isStopped?: () => boolean
  } = {},
): Promise<RaccoonProbeOutcome> {
  const levels = options.levels ?? PROBE_LEVELS
  const stopped = options.isStopped ?? (() => false)

  const baseline = await send(undefined)
  if (!isAccepted(baseline)) return { validation: 'unknown', efforts: [] }

  const sentinel = await send(sentinelValue(() => randomHex()))
  if (stopped()) return { validation: 'unknown', efforts: [] }
  if (isAccepted(sentinel)) return { validation: 'non-validating', efforts: [] }
  if (!isRefusal(sentinel)) return { validation: 'unknown', efforts: [] }

  const efforts: string[] = []
  for (const level of levels) {
    const attempt = await send(level)
    if (stopped()) return { validation: 'unknown', efforts: [] }
    if (isAccepted(attempt)) {
      efforts.push(level)
      continue
    }
    // A decisive refusal is an answer ("this level is not offered"); anything
    // else is silence, and silence voids the run rather than skipping a level.
    if (!isRefusal(attempt)) return { validation: 'unknown', efforts: [] }
  }
  return { validation: 'validating', efforts }
}

/** 24 hex chars of randomness, so a sentinel can never collide with a real value. */
function randomHex(): string {
  return randomBytes(12).toString('hex')
}
