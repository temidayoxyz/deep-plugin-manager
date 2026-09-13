/** Shared test helpers: temp dirs and a fake pnpm that simulates installs. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PnpmRunner } from '../src/runner.ts'

export { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, join, tmpdir }
export const os = { tmpdir }
export const path = { join, dirname: (value: string): string => value }

/** A simulated npm package the fake pnpm can "install". */
export interface FakePackage {
  name: string
  version: string
  /** Whether the fake package satisfies the Harness plugin contract. */
  plugin: boolean
  repo: string
}

/** The behavior knobs of the fake pnpm runner. */
export interface FakePnpmOptions {
  packages: Record<string, FakePackage>
  /** When set, `add` exits nonzero with this output. */
  failAddWith?: string
  /** When set, `remove` exits nonzero with this output. */
  failRemoveWith?: string
}

/**
 * Build a fake pnpm runner over one profile directory. `add <github:spec>`
 * writes the dependency and materializes the package under node_modules;
 * `remove` reverses both. This simulates pnpm closely enough to exercise the
 * lifecycle engine's state handling without a network.
 * @param profileDir - the fake profile the runner operates on.
 * @param options - package catalog and failure injection.
 * @returns the runner plus the list of executed argument lists.
 */
export function createFakePnpm(
  profileDir: string,
  options: FakePnpmOptions,
): PnpmRunner & { calls: string[][] } {
  const calls: string[][] = []
  const manifestPath = join(profileDir, 'package.json')
  const run = async (args: readonly string[]): Promise<{ code: number; output: string }> => {
    calls.push([...args])
    const [command, target] = args
    if (command === 'add') {
      if (options.failAddWith !== undefined) {
        return { code: 1, output: options.failAddWith }
      }
      const spec = target ?? ''
      const hashAt = spec.indexOf('#')
      const repo = (hashAt === -1 ? spec : spec.slice(0, hashAt)).replace(/^github:/, '')
      const ref = hashAt === -1 ? undefined : spec.slice(hashAt + 1)
      const pkg = options.packages[repo]
      if (pkg === undefined) return { code: 1, output: `no such repository ${repo}` }
      // A pinned spec materializes the pinned version; an unpinned spec gets
      // the catalog version.
      const version = ref !== undefined && ref.startsWith('v') ? ref.slice(1) : pkg.version
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: string[] } }
      }
      manifest.dependencies = { ...manifest.dependencies, [pkg.name]: spec }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
      const dir = join(profileDir, 'node_modules', ...pkg.name.split('/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: pkg.name,
        version,
        ...(pkg.plugin ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
      }))
      return { code: 0, output: '' }
    }
    if (command === 'remove') {
      if (options.failRemoveWith !== undefined) {
        return { code: 1, output: options.failRemoveWith }
      }
      const name = target ?? ''
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dependencies?: Record<string, string>
      }
      const dependencies = { ...manifest.dependencies }
      delete dependencies[name]
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies }, null, 2))
      rmSync(join(profileDir, 'node_modules', ...name.split('/')), { recursive: true, force: true })
      return { code: 0, output: '' }
    }
    return { code: 0, output: '' }
  }
  const runner = (async (_profileDir: string, args: readonly string[]) => run(args)) as PnpmRunner & { calls: string[][] }
  runner.calls = calls
  return runner
}

/** Write a minimal valid profile manifest into a directory. */
export function writeProfileManifest(profileDir: string, dependencies: Record<string, string>, bundles: string[]): void {
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'test-profile',
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }, null, 2))
}
