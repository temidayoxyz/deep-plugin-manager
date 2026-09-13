/**
 * Structural types for the Harness host faces Deep Plugin Manager compiles
 * against. The Harness packages are runtime-provided; these shapes describe
 * the subset the plugin uses so no Harness package needs installing.
 *
 * @module dsh-deep-plugin-manager/harness-types
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** A plugin-lifetime effect whose disposer runs at teardown. */
export type Effect = () => (() => void) | void

/** The web-server service subset used to register management routes. */
export interface WebServerHost {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
  }
}

/** The scope handed back once the named services are available. */
export interface HostScope extends WebServerHost {
  /** The Harness home joiner (the `dshHomePath` service): home-relative paths. */
  dshHomePath: (...children: string[]) => string
  /** Register a plugin-lifetime effect; the disposer runs at teardown. */
  effect(apply: Effect, label: string): void
}

/** The host-context face the plugin's `apply` receives. */
export interface ClientContextLike {
  /** Wait for the named services, then run the callback with their scope. */
  inject(services: readonly string[], callback: (scope: HostScope) => void): void
  /** Register a plugin-lifetime effect; the disposer runs at teardown. */
  effect(apply: Effect, label: string): void
}
