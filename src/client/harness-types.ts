/**
 * Structural types for the Harness client faces Deep Plugin Manager compiles
 * against. The Harness packages are runtime-provided; these shapes describe
 * the subset the plugin uses so no Harness package needs installing.
 *
 * @module dsh-deep-plugin-manager/client/harness-types
 */
import type { DeepPluginManagerKey } from './locales.js'

/** Localized copy seat handed to slot components (`t(key, params?)`). */
export interface LocaleSeat {
  t: (key: DeepPluginManagerKey, params?: Record<string, string | number>) => string
}

/** The Harness locale registry subset (`ctx.locale`). */
export interface LocaleHost {
  register(ns: string, dictionaries: Record<string, unknown>): void
  /** Bind a namespace; returns the translate function for its key domain. */
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
}

/** The Harness slots service subset (`ctx.slots`). */
export interface SlotsHost {
  /** Contribute to a slot; the factory runs when the consumer renders it. */
  inject(slot: string, factory: () => unknown): void
  /** Register one entry component into the slot being injected. */
  register(options: SlotRegistration, component: (props: never) => unknown): unknown
}

/** Options of one slot registration. */
export interface SlotRegistration {
  name: string
  id: string
  order: number
  /** Nav label factory, re-evaluated on locale change. */
  label?: () => string
  locale?: string
  inject?: (owner: unknown) => unknown
}

/** A plugin-lifetime effect whose disposer runs at teardown. */
export type Effect = () => (() => void) | void

/** The client-context face the plugin's `apply` receives. */
export interface ClientContextLike {
  /** Register a plugin-lifetime effect; the disposer runs at teardown. */
  effect(apply: Effect, label: string): void
  /** The Harness locale registry. */
  locale: LocaleHost
  /** The Harness slot registry. */
  slots: SlotsHost
}

/** The registry of locale namespaces; Deep Plugin Manager contributes one. */
export interface LocaleNamespaceMap {
  deepPluginManager: DeepPluginManagerKey
}
