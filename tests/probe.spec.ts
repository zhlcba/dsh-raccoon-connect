import { describe, expect, it } from 'vitest'
import { isAccepted, isRefusal, PROBE_LEVELS, runProbeSweep, sentinelValue } from '../src/probe.ts'
import type { RaccoonProbeAttempt } from '../src/upstream.ts'

/**
 * The sweep ORDER is the contract: baseline → sentinel → levels.
 *
 * A probe spends credit, so its result must be interpretable: the sentinel
 * exists to prove the upstream actually checks `reasoning_effort` before any
 * per-level answer is trusted, and any answer that is neither "accepted" nor a
 * decisive 400 refusal is silence, which voids the whole run rather than
 * quietly dropping one level.
 */

const accepted = (): RaccoonProbeAttempt => ({ status: 200, accepted: true, streamed: true })
const refusal = (message = 'params_invalid_error'): RaccoonProbeAttempt => ({ status: 400, accepted: false, streamed: false, message })
const silence = (status = 500): RaccoonProbeAttempt => ({ status, accepted: false, streamed: false })

/** Answers by effort key; `<baseline>` for the no-effort call. */
function scripted(answers: Record<string, RaccoonProbeAttempt>) {
  const seen: (string | undefined)[] = []
  const send = async (effort?: string): Promise<RaccoonProbeAttempt> => {
    seen.push(effort)
    const answer = effort === undefined ? answers['<baseline>'] : answers[effort]
    if (answer !== undefined) return answer
    if (effort?.startsWith('probe_sentinel_') === true) return answers['<sentinel>'] ?? silence()
    return silence()
  }
  return { seen, send }
}

describe('attempt predicates', () => {
  it('counts acceptance only as 200 *and* an SSE data event', () => {
    expect(isAccepted(accepted())).toBe(true)
    expect(isAccepted({ status: 200, accepted: false, streamed: false })).toBe(false)
    expect(isAccepted({ status: 429, accepted: true, streamed: true })).toBe(false)
  })

  it('counts only a 400 shaped as a parameter refusal as decisive', () => {
    expect(isRefusal(refusal())).toBe(true)
    expect(isRefusal({ status: 400, accepted: false, streamed: false, errorCode: '100002' })).toBe(true)
    expect(isRefusal({ status: 400, accepted: false, streamed: false, message: 'invalid_reasoning_effort' })).toBe(true)
    expect(isRefusal({ status: 400, accepted: false, streamed: false, message: 'REASONING_EFFORT unsupported' })).toBe(true)
    // An unrelated 400 is silence, not proof the field is checked.
    expect(isRefusal({ status: 400, accepted: false, streamed: false, errorCode: '999999', message: 'bad prompt' })).toBe(false)
    // Only a 400 is decisive; the same phrase arriving on another status is not.
    expect(isRefusal({ status: 403, accepted: false, streamed: false, message: 'params_invalid' })).toBe(false)
  })

  it('builds a sentinel no real value could collide with', () => {
    expect(sentinelValue(() => 'a'.repeat(24))).toBe('probe_sentinel_aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(sentinelValue(() => 'a'.repeat(24))).not.toBe(sentinelValue(() => 'b'.repeat(24)))
  })
})

describe('runProbeSweep', () => {
  it('a failing baseline voids the run before the sentinel is even sent', async () => {
    const t = scripted({ '<baseline>': silence(500) })
    const outcome = await runProbeSweep(t.send)
    expect(outcome).toEqual({ validation: 'unknown', efforts: [] })
    // One request only: the sweep never spends the sentinel or five levels on
    // a transport that cannot answer the trivial question.
    expect(t.seen).toEqual([undefined])
  })

  it('an accepted sentinel ends the run as non-validating with zero level requests', async () => {
    // Every per-level answer such an upstream could give would be a false
    // positive, so testing levels after this point would only spend credit on
    // noise — the throw in `send` makes that a test failure, not a smell.
    const t = scripted({ '<baseline>': accepted(), '<sentinel>': accepted() })
    const outcome = await runProbeSweep(async effort => {
      t.seen.push(effort)
      if (effort === undefined) return accepted()
      if (effort.startsWith('probe_sentinel_')) return accepted()
      throw new Error(`levels must not be probed after an accepted sentinel, got ${effort}`)
    })
    expect(outcome).toEqual({ validation: 'non-validating', efforts: [] })
    expect(t.seen).toHaveLength(2)
    expect(t.seen[1]).toMatch(/^probe_sentinel_[0-9a-f]{24}$/u)
  })

  it('a sentinel that is neither accepted nor decisively refused voids the run after two requests', async () => {
    for (const answer of [silence(500), silence(429), refusal('bad gateway html')]) {
      const seen: (string | undefined)[] = []
      const outcome = await runProbeSweep(async (effort?: string) => {
        seen.push(effort)
        return effort === undefined ? accepted() : answer
      })
      expect(outcome).toEqual({ validation: 'unknown', efforts: [] })
      // The refusal to guess stops the sweep at the sentinel, before any
      // level can spend on a meaningless question. (The last answer above is
      // a 400 *without* the refusal shape — still silence, still void.)
      expect(seen).toHaveLength(2)
    }
  })

  it('tests levels in picker order and keeps only the accepted spellings', async () => {
    const t = scripted({
      '<baseline>': accepted(),
      '<sentinel>': refusal(),
      low: accepted(),
      medium: refusal(),
      high: accepted(),
      xhigh: refusal(),
      max: accepted(),
    })
    const outcome = await runProbeSweep(t.send)
    expect(outcome).toEqual({ validation: 'validating', efforts: ['low', 'high', 'max'] })
    expect(t.seen[0]).toBeUndefined()
    expect(String(t.seen[1])).toMatch(/^probe_sentinel_/u)
    expect(t.seen.slice(2)).toEqual([...PROBE_LEVELS])
  })

  it('one non-decisive level answer voids the entire run', async () => {
    // Silence mid-run cannot be read as "this model simply lacks that level":
    // a transient 500 must not cost the user a picker that misstates what was
    // measured.
    const t = scripted({ '<baseline>': accepted(), '<sentinel>': refusal(), low: accepted(), medium: silence(500) })
    const outcome = await runProbeSweep(t.send)
    expect(outcome).toEqual({ validation: 'unknown', efforts: [] })
    expect(t.seen.slice(2)).toEqual(['low', 'medium'])
  })

  it('honors a stop request made between levels', async () => {
    // The sentinel is refused (validation proven), the first level is
    // accepted, and then the user signs out. The partial answer is worth
    // nothing, so the stop voids the run at once.
    const seen: (string | undefined)[] = []
    const outcome = await runProbeSweep(async (effort?: string) => {
      seen.push(effort)
      if (effort === undefined) return accepted()
      if (effort.startsWith('probe_sentinel_')) return refusal()
      return accepted()
    }, { isStopped: () => seen.length >= 3 })
    expect(outcome).toEqual({ validation: 'unknown', efforts: [] })
    expect(seen).toHaveLength(3)
  })

  it('a validating upstream that accepts nothing still ends decisive', async () => {
    const t = scripted({
      '<baseline>': accepted(),
      '<sentinel>': refusal(),
      low: refusal(),
      medium: refusal(),
      high: refusal(),
      xhigh: refusal(),
      max: refusal(),
    })
    const outcome = await runProbeSweep(t.send)
    // Every level refused decisively: the sweep learned the field is checked
    // and this model takes none of the spellings — a usable answer, not an
    // `unknown`.
    expect(outcome).toEqual({ validation: 'validating', efforts: [] })
  })
})
