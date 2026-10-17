/**
 * Loopback request guards shared by the shim and the plugin's HTTP routes.
 *
 * Duplicated security code drifts, and this is code whose only job is to say
 * "no" to the wrong caller, so both servers ask this module the same questions.
 */

import { timingSafeEqual } from 'node:crypto'

/**
 * Whether a `Host` header value names this machine.
 *
 * Bracketed IPv6 needs its own unwrapping step *before* the port is removed:
 * `::1` has colons of its own, and naively taking everything before the first
 * colon yields the empty string, which would reject the one IPv6 spelling a
 * loopback client actually sends.
 */
export function isLoopbackHost(value: string | undefined): boolean {
  const host = hostnameOf(value)
  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || host.startsWith('127.')
}

/** Strip brackets and the port, leaving the address a client meant to reach. */
function hostnameOf(value: string | undefined): string {
  const raw = value?.trim().toLowerCase() ?? ''
  if (raw === '') return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end === -1 ? raw : raw.slice(1, end)
  }
  const parts = raw.split(':')
  // Exactly one colon means host:port; more than one means a bare IPv6 address.
  return parts.length === 2 && /^\d+$/u.test(parts[1]!) ? parts[0]! : raw
}

/**
 * Whether an `Origin` header is acceptable.
 *
 * An absent Origin is a non-browser client (another local process, curl), which
 * the `Host` check already covers; a present one must name a loopback host.
 */
export function isLoopbackOrigin(value: string | undefined): boolean {
  if (value === undefined || value === '') return true
  try {
    return isLoopbackHost(new URL(value).hostname)
  } catch {
    return false
  }
}

/** The bearer token a request presented, or the empty string. */
export function bearerOf(header: string | undefined): string {
  return header?.startsWith('Bearer ') === true ? header.slice(7) : ''
}

/**
 * Length-hiding string comparison.
 *
 * Both callers compare a secret, so the comparison must not leak how much of it
 * matched; a length mismatch still costs one full comparison to keep timing
 * uniform.
 */
export function constantTimeEquals(presented: string, expected: string): boolean {
  const actual = Buffer.from(presented)
  const secret = Buffer.from(expected)
  if (actual.length !== secret.length) {
    timingSafeEqual(secret, secret)
    return false
  }
  return timingSafeEqual(actual, secret)
}
