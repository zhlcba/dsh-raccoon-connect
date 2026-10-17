/**
 * Package version reported by status and doctor output.
 *
 * Injected at build time by tsdown's `define` (see tsdown.config.ts), which
 * replaces `__DSH_RACCOON_VERSION__` with package.json's `version`. Keeping
 * package.json as the single source of truth avoids the drift where a release
 * bumps npm's version but the code still reports the old one. The
 * `typeof === 'string'` guard keeps the bundle harmless if a build forgets the
 * define (it falls back to a clearly-dev marker).
 */
declare const __DSH_RACCOON_VERSION__: string

export const RACCOON_CONNECT_VERSION: string =
  typeof __DSH_RACCOON_VERSION__ === 'string' ? __DSH_RACCOON_VERSION__ : '0.0.0-dev'
