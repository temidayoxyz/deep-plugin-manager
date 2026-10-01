/**
 * Deep Plugin Manager host half.
 *
 * Resolves the Harness profile directory it runs from, builds the lifecycle
 * manager over it, and registers the management JSON routes on the Harness
 * web server (behind the same auth gate as the rest of the UI). The browser
 * half — a Settings page — calls these routes same-origin.
 *
 * @module dsh-deep-plugin-manager
 */
import type { ClientContextLike } from './harness-types.ts'
import { createApi, handleRequest, ROUTE_PREFIX } from './routes.ts'
import { createPnpmRunner } from './runner.ts'
import { resolveProfileDir } from './profile.ts'

/** Required services: the Harness home (profile lookup) and the web server. */
export const inject = ['dshHomePath', 'webServer']

/** The route prefix every management endpoint lives under (from ./routes.ts). */
export { ROUTE_PREFIX }

/** Plugin configuration. */
export interface Config {
  /**
   * pnpm executable name or path, resolved through `PATH` like the Harness
   * `dsh plugin` command.
   *
   * Leave this unset to use the pnpm the Harness itself bundles, which is the
   * one the profile was installed from. Naming a pnpm of a different major
   * makes every operation fail: pnpm links a profile's packages from a store
   * named for its own major version and refuses a tree from another.
   */
  pnpmCommand?: string
}

/**
 * Mount the plugin manager.
 * @param ctx - host context (home path and web server are injected).
 * @param config - the pnpm executable to run package operations with.
 */
export function apply(ctx: ClientContextLike, config?: Config): void {
  ctx.inject(['dshHomePath', 'webServer'], (scope) => {
    const profileDir = resolveProfileDir(import.meta.url, scope.dshHomePath('profiles'))
    const api = createApi({ profileDir, runner: createPnpmRunner(config?.pnpmCommand) })
    scope.effect(
      () => scope.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => { void handleRequest(req, res, api) },
      }),
      'deep-plugin-manager: management routes',
    )
  })
}
