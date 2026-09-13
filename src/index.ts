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
import { createApi, handleRequest } from './routes.ts'
import { createPnpmRunner } from './runner.ts'
import { resolveProfileDir } from './profile.ts'

/** Required services: the Harness home (profile lookup) and the web server. */
export const inject = ['dshHomePath', 'webServer']

/** The route prefix every management endpoint lives under. */
export const ROUTE_PREFIX = '/deep-plugin-manager'

/**
 * Mount the plugin manager.
 * @param ctx - host context (home path and web server are injected).
 */
export function apply(ctx: ClientContextLike): void {
  ctx.inject(['dshHomePath', 'webServer'], (scope) => {
    const profileDir = resolveProfileDir(import.meta.url, scope.dshHomePath('profiles'))
    const api = createApi({ profileDir, runner: createPnpmRunner() })
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
