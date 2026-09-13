/**
 * The pnpm runner: every package operation Deep Plugin Manager performs goes
 * through here as a validated argument list — never a shell string. Arguments
 * are checked against a safe charset before spawn (the profile manifest's own
 * dependency specs and names are the only variable parts, and both are
 * npm-package names), the working directory is the profile itself, and output
 * is captured with a size cap so failures surface their real cause.
 *
 * @module dsh-deep-plugin-manager/runner
 */
import { spawn } from 'node:child_process'
import { RunnerError } from './errors.ts'

/** One completed pnpm invocation. */
export interface PnpmResult {
  /** Process exit code (0 = success). */
  code: number
  /** Combined stdout+stderr, capped. */
  output: string
}

/** Executable pnpm operation against one directory. */
export type PnpmRunner = {
  (profileDir: string, args: readonly string[]): Promise<PnpmResult>
}

/** Arguments must stay inside this charset: the Windows spawn path goes
    through a shell, so anything outside can never be allowed to ride along. */
const SAFE_ARG = /^[A-Za-z0-9@/:._#-]+$/

/** Combined-output cap; pnpm failure diagnostics live at the tail. */
const MAX_OUTPUT_BYTES = 64 * 1024

/** Install/update wall-clock ceiling; kills the child instead of hanging the UI. */
const TIMEOUT_MS = 10 * 60 * 1000

/**
 * Create the pnpm runner. The executable defaults to `pnpm` on PATH and may
 * be pointed elsewhere with `DSH_PNPM_EXECUTABLE` (used by tests and unusual
 * deployments).
 * @param executable - pnpm executable override.
 * @returns the runner.
 */
export function createPnpmRunner(executable: string = process.env.DSH_PNPM_EXECUTABLE ?? 'pnpm'): PnpmRunner {
  return async (profileDir: string, args: readonly string[]): Promise<PnpmResult> => {
    for (const argument of args) {
      if (!SAFE_ARG.test(argument)) {
        throw new RunnerError(`Refusing pnpm argument outside the safe charset: ${JSON.stringify(argument)}`)
      }
    }
    return new Promise<PnpmResult>((resolve, reject) => {
      // Windows resolves pnpm through its .cmd shim, which Node refuses to
      // spawn without a shell; the per-argument charset check above is what
      // keeps the shell path safe on every platform.
      const child = spawn(executable, [...args], {
        cwd: profileDir,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let failure: Error | undefined
      let settled = false
      const append = (chunk: Buffer): void => {
        output = `${output}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_BYTES)
      }
      const timer = setTimeout(() => {
        failure = new RunnerError('pnpm did not finish within 10 minutes and was stopped.')
        child.kill('SIGKILL')
      }, TIMEOUT_MS)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', append)
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', append)
      child.once('error', (error) => {
        failure = error instanceof Error
          ? new RunnerError(`pnpm could not be started: ${error.message}`, String(error))
          : new RunnerError('pnpm could not be started.')
      })
      child.once('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (failure !== undefined) {
          reject(failure)
          return
        }
        resolve({ code: code ?? 1, output })
      })
    })
  }
}

/**
 * Run one pnpm operation and translate a nonzero exit into a runner failure
 * whose message carries the tool output, with the common pnpm ≥10 build-block
 * cause explained inline when the output names it.
 * @param runner - the pnpm runner.
 * @param profileDir - the profile directory to run in.
 * @param args - validated pnpm arguments.
 * @param action - human description of the operation for error messages.
 * @returns the result when the exit code is 0.
 * @throws {RunnerError} when pnpm exits nonzero.
 */
export async function runPnpm(
  runner: PnpmRunner,
  profileDir: string,
  args: readonly string[],
  action: string,
): Promise<PnpmResult> {
  const result = await runner(profileDir, args)
  if (result.code !== 0) {
    const output = result.output.trim()
    const buildHint = /allowBuilds|build scripts|prepare|ignored build/i.test(output)
      ? ' pnpm likely blocked the package build scripts: add the key it printed under '
        + '`allowBuilds` in the profile pnpm-workspace.yaml, then retry.'
      : ''
    throw new RunnerError(`pnpm failed while trying to ${action}.${buildHint}`, output)
  }
  return result
}
