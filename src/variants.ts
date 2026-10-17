/**
 * The 小浣熊 product variants this plugin serves.
 *
 * Everything that can differ between two SenseTime desktop clients — gateway
 * base, credential location, file names, display identity, routes — is one
 * descriptor here, so no module carries its own `if (raccoon)` branch and
 * adding a second product (e.g. 代码小浣熊) is a data change rather than a
 * refactor. Today there is exactly one: 办公小浣熊 desktop.
 *
 * This module is host-side (it names files and env vars). The browser half
 * takes the same routes from the Node-free `status-paths.ts`, which stays the
 * single source shared by both halves.
 *
 * @module dsh-raccoon-connect/variants
 */

import { RACCOON_PROBE_PATH, RACCOON_STATUS_PATH } from './status-paths.ts'

/** One 小浣熊 product variant. */
export interface RaccoonVariant {
  /** Provider id registered with DSH, e.g. `raccoon`. */
  id: string
  /** Model-group heading and card title, e.g. `商汤小浣熊`. */
  displayName: string
  /** Desktop app name as users know it, for diagnostics and error copy. */
  appName: string
  /** OpenAI-compatible LLM gateway, including its `/llm/v2` suffix. */
  llmBase: string
  /** Site origin the auth and billing endpoints hang off. */
  siteOrigin: string
  /** Env var that overrides the desktop credential file location outright. */
  env: string
  /** Env var the desktop app itself uses to relocate its config directory. */
  configDirEnv: string
  /** Config directory relative to the home dir when `configDirEnv` is unset. */
  configDirRel: string
  /** Basename of the desktop app's own credential file in that directory. */
  desktopFilename: string
  /** Basename of the plugin-owned credential copy under `$DSH_HOME`. */
  ownFilename: string
  /** Basename of the plugin-owned probe-record file under `$DSH_HOME`. */
  probeFilename: string
  /** Basename of the plugin-owned saved-catalog file under `$DSH_HOME`. */
  catalogFilename: string
  /** Same-origin status route consumed by this variant's card. */
  statusPath: string
  /** Same-origin probe-control route consumed by this variant's card. */
  probePath: string
}

/**
 * 办公小浣熊 desktop.
 *
 * Its credential file is the one the app already maintains for its own local
 * agent (`box-agent`), which is what makes zero-configuration reuse possible:
 * the app writes it on sign-in and on every token refresh, and the plugin only
 * ever has to read — and, when it refreshes, write back in the same shape.
 */
export const RACCOON_PRIMARY: RaccoonVariant = {
  id: 'raccoon',
  displayName: '商汤小浣熊',
  appName: '商汤小浣熊',
  llmBase: 'https://xiaohuanxiong.com/api/web/llm/v2',
  siteOrigin: 'https://xiaohuanxiong.com',
  env: 'RACCOON_AUTH_FILE',
  configDirEnv: 'BOX_AGENT_CONFIG_DIR',
  configDirRel: '.box-agent/config',
  desktopFilename: 'auth.json',
  ownFilename: '.raccoon-auth.json',
  probeFilename: '.raccoon-probe.json',
  catalogFilename: '.raccoon-catalog.json',
  statusPath: RACCOON_STATUS_PATH,
  probePath: RACCOON_PROBE_PATH,
}

/** Every variant the plugin registers. */
export const ALL_VARIANTS: readonly RaccoonVariant[] = [RACCOON_PRIMARY]

/** Look up a variant by provider id. */
export function variantFor(id: string): RaccoonVariant | undefined {
  return ALL_VARIANTS.find(variant => variant.id === id)
}
