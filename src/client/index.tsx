/**
 * Browser half: 小浣熊 account status inside Plugin configuration, plus the
 * composer-side reasoning-effort control.
 *
 * A dsh client module is a plain ES module exporting `name`, `inject`, and
 * `apply(ctx, config)`; there is no definePlugin wrapper. This file registers
 * nothing at import time — the harness calls `apply` once its declared
 * services are live.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { RaccoonProbeControl } from './RaccoonProbeControl.tsx'
import { CARD_VARIANTS, RaccoonPluginCard } from './RaccoonPluginCard.tsx'
import type { RaccoonPluginCardInjected } from './RaccoonPluginCard.tsx'
import { en, zh } from './locales.ts'
import type { RaccoonSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 小浣熊 plugin card copy. */
    'settings.raccoon': RaccoonSettingsKey
  }
}

/** Stable browser-plugin name; distinct from the host plugin so both can coexist. */
export const name = 'dsh-raccoon-connect-client'
/**
 * Client services this contribution needs.
 *
 * `slots` is the renderer's registration API, `locale` the dictionary
 * registry, and the entry's composer control resolves the active session's
 * model directory through `remote.session` — declaring it is required by the
 * Desktop renderer; without it Cordis rejects `directoryFor()` before this
 * bundle can finish registering its contributions.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/**
 * Register card copy, the per-variant status cards, and the composer control.
 *
 * The entire body is wrapped so that a DSH slot-API breaking change (for
 * example the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades to
 * a `console.error` instead of throwing into the DSH loader and raising the
 * red "Failed to load plugins" banner. The host provider keeps working: the
 * `raccoon` model channel is unaffected, and the status route still reports
 * host health to anything that reads it.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.raccoon'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-raccoon-connect: settings copy')
    const t = ctx.locale.bind(namespace) as RaccoonPluginCardInjected['t']
    // One card per variant. They show different accounts, balances, and model
    // sets, so a single merged card could not say which account a number
    // belongs to. The slot is key-dispatched: N keys, one component — adding
    // a product means appending its descriptor to CARD_VARIANTS.
    // DSH >= 0.2.0: the settings-plugins tab slot is not part of the render
    // slot union exported by the installed client types, and its registration
    // shape (`key`/`priority`) no longer type-checks against the new slot API
    // either. The card is therefore contributed through an untyped bridge: at
    // runtime the slot either exists (card renders as before) or does not
    // (registration throws and the catch below degrades to no card). The host
    // provider — models, catalog, credentials — is entirely independent of it.
    type SlotName = Parameters<typeof ctx.slots.inject>[0]
    const SETTINGS_TAB_SLOT = 'settings.plugins.tab' as SlotName
    for (const [index, variant] of CARD_VARIANTS.entries()) {
      const register = ctx.slots.register as unknown as (
        options: Record<string, unknown>,
        component: typeof RaccoonPluginCard,
      ) => () => void
      ctx.slots.inject(SETTINGS_TAB_SLOT, () =>
        register(
          {
            name: SETTINGS_TAB_SLOT,
            key: variant.id,
            priority: 30 - index,
            inject: (): RaccoonPluginCardInjected => ({ t, variant }),
          },
          RaccoonPluginCard,
        ),
      )
    }
    // A single composer entry for every session; the selected provider picks
    // the variant (and routes) it acts on, and any other provider renders the
    // control as nothing.
    ctx.inject(['modelDirectories'], scope => {
      scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right',
        id: 'raccoon-probe',
        order: 10,
        inject: sessionId => ({
          directory: scope.modelDirectories.directoryFor(
            sessionId as Parameters<typeof scope.modelDirectories.directoryFor>[0],
          ).store,
          t,
        }),
      }, RaccoonProbeControl))
    })
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-raccoon-connect] client card failed to load (host provider unaffected):', error)
  }
}
