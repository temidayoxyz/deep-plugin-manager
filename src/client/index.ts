/**
 * Deep Plugin Manager browser half: the "Plugin Manager" settings page.
 * Registers a `settings.section` entry whose copy comes from the
 * `deepPluginManager` locale namespace and whose data comes from the
 * same-origin management routes the Host half registers.
 *
 * @module dsh-deep-plugin-manager/client
 */
import type { ClientContextLike } from './harness-types.ts'
import { PluginManagerSection } from './PluginManagerSection.tsx'
import { en, NS, zh } from './locales.ts'
import { SECTION_STYLES } from './styles.ts'

/** The settings nav identity for this page. */
export const SECTION_ID = 'deep-plugin-manager'

/** Required services: slots and locale. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: dictionaries, stylesheet, and the settings page.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deep-plugin-manager: dictionaries')

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-deep-plugin-manager'
    tag.dataset.pluginCss = 'dsh-deep-plugin-manager/section.css'
    tag.textContent = SECTION_STYLES
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'deep-plugin-manager: section stylesheet')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 30,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
  }, PluginManagerSection))
}
