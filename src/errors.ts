/**
 * Typed failures mapped to HTTP status codes by the route layer. Every
 * lifecycle failure carries a user-presentable message; pnpm output rides
 * along (`detail`) so the UI can show the real cause without log diving.
 *
 * @module dsh-deep-plugin-manager/errors
 */

/** Base class: a failure with an HTTP status and a presentable message. */
export class ManagerError extends Error {
  /** HTTP status the route layer should respond with. */
  readonly status: number
  /** Machine-readable kind for the client UI. */
  readonly kind: string
  /** Captured tool output (pnpm/git) that explains the failure, if any. */
  readonly detail?: string

  /**
   * @param kind - machine-readable failure kind.
   * @param message - user-presentable message.
   * @param status - HTTP status for the route layer.
   * @param detail - captured tool output, when the failure came from a tool.
   */
  constructor(kind: string, message: string, status: number, detail?: string) {
    super(message)
    this.name = 'ManagerError'
    this.kind = kind
    this.status = status
    this.detail = detail
  }
}

/** A GitHub reference or repository the manager refuses to act on. */
export class InvalidRefError extends ManagerError {
  constructor(message: string, detail?: string) {
    super('invalid-ref', message, 400, detail)
  }
}

/** The repository resolved fine but is not a compatible Harness plugin. */
export class NotAPluginError extends ManagerError {
  constructor(message: string, detail?: string) {
    super('not-a-plugin', message, 400, detail)
  }
}

/** The requested plugin is not installed in this profile. */
export class NotInstalledError extends ManagerError {
  constructor(name: string) {
    super('not-installed', `Plugin "${name}" is not installed in this profile.`, 404)
  }
}

/** The plugin is already installed (duplicate install attempt). */
export class AlreadyInstalledError extends ManagerError {
  constructor(name: string) {
    super('already-installed', `Plugin "${name}" is already installed. Use update to move versions.`, 409)
  }
}

/** The name belongs to the Harness core or to the manager itself. */
export class ReservedNameError extends ManagerError {
  constructor(name: string) {
    super(
      'reserved-name',
      `"${name}" is a Harness-owned package and cannot be managed here.`,
      403,
    )
  }
}

/** pnpm (or another tool) failed; `detail` carries its output. */
export class RunnerError extends ManagerError {
  constructor(message: string, detail?: string) {
    super('runner-failed', message, 502, detail)
  }
}

/** GitHub was unreachable, rate-limited, or returned an error. */
export class GitHubError extends ManagerError {
  constructor(message: string, detail?: string) {
    super('github-failed', message, 502, detail)
  }
}
