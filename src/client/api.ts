/**
 * Same-origin client for the management routes. Every call carries the UI's
 * auth cookie; failures arrive as `{ error: { kind, message, detail? } }` and
 * surface as typed rejections the section renders.
 *
 * @module dsh-deep-plugin-manager/client/api
 */

/** One installed plugin as the list endpoint reports it. */
export interface PluginEntry {
  name: string
  version: string
  spec: string
  enabled: boolean
  /** Mounted through the profile's cordis.patch.yml; the toggle belongs there. */
  patchMounted?: boolean
  /** Display name: the GitHub repository name when GitHub-sourced. */
  displayName?: string
  description?: string
  repository?: string
  author?: string
}

/** Result of one install. */
export interface InstallResult {
  name: string
  version: string
  spec: string
  restartRequired: true
}

/** Result of an update check. */
export interface UpdateCheck {
  name: string
  current: string
  latest: { tag: string; name: string; url: string; publishedAt: string } | null
  updateAvailable: boolean
  releaseUrl?: string
}

/** Result of one update. */
export interface UpdateResult {
  name: string
  version: string
  restartRequired: true
}

/** One failed management call, with the tool output when present. */
export class ApiError extends Error {
  readonly kind: string
  readonly detail?: string

  /**
   * @param kind - machine-readable failure kind from the route layer.
   * @param message - presentable failure message.
   * @param detail - captured tool output, when present.
   */
  constructor(kind: string, message: string, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.detail = detail
  }
}

/** One JSON request to the management API. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = await response.json().catch(() => null) as
    | { error?: { kind?: unknown; message?: unknown; detail?: unknown } }
    | null
  if (!response.ok) {
    const error = body?.error
    throw new ApiError(
      typeof error?.kind === 'string' ? error.kind : 'unknown',
      typeof error?.message === 'string' ? error.message : `Request failed (${String(response.status)}).`,
      typeof error?.detail === 'string' ? error.detail : undefined,
    )
  }
  return body as T
}

/** List the profile's installed plugins. */
export function listPlugins(): Promise<{ plugins: PluginEntry[] }> {
  return call('/deep-plugin-manager/plugins')
}

/** Install one GitHub-hosted plugin. */
export function installPlugin(input: string): Promise<{ result: InstallResult }> {
  return call('/deep-plugin-manager/install', { method: 'POST', body: JSON.stringify({ input }) })
}

/** Enable one installed plugin. */
export function enablePlugin(name: string): Promise<{ ok: true }> {
  return call('/deep-plugin-manager/enable', { method: 'POST', body: JSON.stringify({ name }) })
}

/** Disable one installed plugin (stays installed). */
export function disablePlugin(name: string): Promise<{ ok: true }> {
  return call('/deep-plugin-manager/disable', { method: 'POST', body: JSON.stringify({ name }) })
}

/** Uninstall one plugin. */
export function uninstallPlugin(name: string): Promise<{ ok: true }> {
  return call('/deep-plugin-manager/uninstall', { method: 'POST', body: JSON.stringify({ name }) })
}

/** Check one plugin's GitHub repository for a newer release. */
export function checkUpdate(name: string): Promise<UpdateCheck> {
  return call(`/deep-plugin-manager/check-update?name=${encodeURIComponent(name)}`)
}

/** Update one plugin from its GitHub repository. */
export function updatePlugin(name: string): Promise<{ result: UpdateResult }> {
  return call('/deep-plugin-manager/update', { method: 'POST', body: JSON.stringify({ name }) })
}
