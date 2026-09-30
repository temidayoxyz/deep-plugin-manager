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
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
 * Find a pnpm whose store matches the one the profile was installed from.
 *
 * pnpm links `node_modules` from a store directory whose name carries its own
 * major version (`store/v10`, `store/v11`). A pnpm of a different major
 * refuses to touch that tree with ERR_PNPM_UNEXPECTED_STORE, which is what
 * happens when the harness installed the profile with its bundled pnpm and the
 * manager then runs whatever `pnpm` resolves to on PATH.
 *
 * The harness ships the pnpm it used, so that copy is preferred: it is by
 * construction the one whose store the profile is linked from.
 *
 * @returns an executable path, or undefined when no bundled pnpm is present.
 */
function findBundledPnpm(): string | undefined {
  const roots = [
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.cjs'),
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
  ].filter((candidate): candidate is string => candidate !== undefined)
  for (const candidate of roots) {
    if (existsSync(candidate)) return candidate
  }
  // A differently-installed harness keeps the same layout under another name.
  const programs = process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Programs')
  if (programs !== undefined && existsSync(programs)) {
    for (const entry of readdirSync(programs, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.includes('DeepSeek')) continue
      const candidate = join(programs, entry.name, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.cjs')
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Resolve which pnpm to run.
 *
 * Precedence: an explicit configuration or environment override, then the
 * harness's own bundled pnpm, then `pnpm` on PATH. The bundled copy matters
 * because it is the one the profile was installed from, so a PATH pnpm of a
 * different major would fail on the store rather than on anything about the
 * requested operation.
 *
 * @param configured - the plugin's `pnpmCommand`, when set
 * @returns the executable to spawn
 */
export function resolvePnpm(configured?: string): string {
  const override = configured ?? process.env.DSH_PNPM_EXECUTABLE
  if (override !== undefined && override.length > 0) return override
  return findBundledPnpm() ?? 'pnpm'
}

/** A bundled pnpm is a `.cjs` entry, which `spawn` cannot execute directly. */
function needsNode(executable: string): boolean {
  return executable.endsWith('.cjs') || executable.endsWith('.js')
}

/**
 * Whether pnpm refused the profile because its store belongs to another major.
 *
 * pnpm links `node_modules` from `store/v<major>`, and a different major refuses
 * the tree rather than reinstalling it, so this is a configuration mismatch
 * rather than anything about the requested operation.
 */
function isStoreMismatch(output: string): boolean {
  return output.includes('ERR_PNPM_UNEXPECTED_STORE')
}

/** The bundled pnpm path, named in the error so the remedy is concrete. */
function describeBundled(): string {
  const bundled = findBundledPnpm()
  return bundled === undefined ? '' : ` (${bundled})`
}

/**
 * Create the pnpm runner. The executable is resolved by {@link resolvePnpm};
 * tests pass one explicitly.
 * @param executable - pnpm executable override.
 * @returns the runner.
 */
export function createPnpmRunner(executable?: string): PnpmRunner {
  const resolved = resolvePnpm(executable)
  return async (profileDir: string, args: readonly string[]): Promise<PnpmResult> => {
    for (const argument of args) {
      if (!SAFE_ARG.test(argument)) {
        throw new RunnerError(`Refusing pnpm argument outside the safe charset: ${JSON.stringify(argument)}`)
      }
    }
    return new Promise<PnpmResult>((resolve, reject) => {
      // Windows resolves pnpm through its .cmd shim, which Node refuses to
      // spawn without a shell; the per-argument charset check above is what
      // keeps the shell path safe on every platform. A bundled pnpm is a `.cjs`
      // entry rather than a command, so it runs under this process's Node
      // instead of a shell, which also keeps it off PATH.
      const viaNode = needsNode(resolved)
      const child = viaNode
        ? spawn(process.execPath, [resolved, ...args], {
          cwd: profileDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        : spawn(resolved, [...args], {
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
        if (code !== 0 && isStoreMismatch(output)) {
          // pnpm's own text names the store directories but not the remedy, so
          // the operation fails for a reason that looks like a dependency
          // problem. Say what actually happened and which pnpm fixes it.
          reject(new RunnerError(
            `This profile was installed with a different pnpm major version, so its packages are linked from a ` +
            `store this pnpm will not use. Run the operation again once \`pnpmCommand\` points at the pnpm the ` +
            `Harness itself uses${describeBundled()}.`,
            output,
          ))
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
