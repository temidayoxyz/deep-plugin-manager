/**
 * Lifecycle tests over a fake pnpm: install (success, invalid repo failure,
 * non-plugin rejection with rollback, duplicates), enable/disable,
 * uninstall (with failure rollback), update (newer release, up-to-date,
 * failed update leaves state intact), and multi-plugin coexistence.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'
import {
  createFakePnpm, mkdtempSync, rmSync, writeProfileManifest,
  type FakePackage,
} from './helpers.ts'
import {
  AlreadyInstalledError, InvalidRefError, ManagerError, NotAPluginError, NotInstalledError, ReservedNameError,
} from '../src/errors.ts'
import { createPluginManager } from '../src/lifecycle.ts'
import type { PnpmRunner } from '../src/runner.ts'
import type { ProfileManifest } from '../src/profile.ts'

interface Session {
  manager: ReturnType<typeof createPluginManager>
  profileDir: string
  runner: ReturnType<typeof createFakePnpm>
}

/** One isolated profile + manager over a fake pnpm; dispose removes the tree. */
function makeSession(
  packages: Record<string, FakePackage>,
  options: {
    failAddWith?: string
    failRemoveWith?: string
    latestRelease?: { tag: string; name: string; url: string; publishedAt: string } | null
    runnerOverride?: (args: readonly string[]) => { code: number; output: string } | undefined
  } = {},
): Session {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpm-lifecycle-'))
  writeProfileManifest(profileDir, {}, [])
  const runner = createFakePnpm(profileDir, {
    packages,
    failAddWith: options.failAddWith,
    failRemoveWith: options.failRemoveWith,
  })
  // The override answers first; returning undefined delegates to the fake so
  // a targeted failure (one pinned update) does not break the setup install.
  const runnerAdapter: PnpmRunner = options.runnerOverride === undefined
    ? runner
    : async (_profileDir: string, args: readonly string[]) => {
      const overridden = options.runnerOverride?.(args)
      return overridden ?? runner(_profileDir, args)
    }
  const manager = createPluginManager({
    profileDir,
    runner: runnerAdapter,
    latestReleaseFn: async () => options.latestRelease ?? null,
  })
  return { manager, profileDir, runner: runner as unknown as ReturnType<typeof createFakePnpm> }
}

function dispose(session: Session): void {
  rmSync(session.profileDir, { recursive: true, force: true })
}

function readState(profileDir: string): { dependencies: Record<string, string>; bundles: string[] } {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as ProfileManifest
  return { dependencies: manifest.dependencies ?? {}, bundles: manifest.dsh?.profile?.bundles ?? [] }
}

function readInstalledVersion(profileDir: string, name: string): string {
  const manifest = JSON.parse(
    readFileSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'),
  ) as { version?: string }
  return manifest.version ?? ''
}

const contrast: FakePackage = { name: 'dsh-deep-contrast', version: '0.1.0', plugin: true, repo: 'temidayoxyz/deep-contrast' }
const tariff: FakePackage = { name: 'dsh-deep-tariff', version: '1.2.1', plugin: true, repo: 'temidayoxyz/deep-tariff' }
const notAPlugin: FakePackage = { name: 'not-a-plugin', version: '9.9.9', plugin: false, repo: 'someone/library' }

describe('install', () => {
  it('installs a valid plugin, enables it, and reports the result', async () => {
    const session = makeSession({ 'temidayoxyz/deep-contrast': contrast })
    try {
      const result = await session.manager.install('temidayoxyz/deep-contrast')
      assert.equal(result.name, 'dsh-deep-contrast')
      assert.equal(result.version, '0.1.0')
      assert.equal(result.restartRequired, true)
      const state = readState(session.profileDir)
      assert.equal(state.dependencies['dsh-deep-contrast'], 'github:temidayoxyz/deep-contrast')
      assert.deepEqual(state.bundles, ['dsh-deep-contrast'])
    } finally {
      dispose(session)
    }
  })

  it('rolls back a non-plugin package and reports it cleanly', async () => {
    const session = makeSession({ 'someone/library': notAPlugin })
    try {
      await assert.rejects(
        () => session.manager.install('someone/library'),
        NotAPluginError,
      )
      const state = readState(session.profileDir)
      assert.equal(Object.keys(state.dependencies).length, 0)
      assert.deepEqual(state.bundles, [])
      assert.equal(existsSync(join(session.profileDir, 'node_modules', 'not-a-plugin')), false)
    } finally {
      dispose(session)
    }
  })

  it('surfaces a pnpm failure without changing state', async () => {
    const session = makeSession(
      { 'temidayoxyz/deep-contrast': contrast },
      { failAddWith: 'ERR something broke' },
    )
    try {
      await assert.rejects(() => session.manager.install('temidayoxyz/deep-contrast'), ManagerError)
      const state = readState(session.profileDir)
      assert.equal(Object.keys(state.dependencies).length, 0)
    } finally {
      dispose(session)
    }
  })

  it('rejects an install of an already-installed plugin', async () => {
    const session = makeSession({ 'temidayoxyz/deep-contrast': contrast })
    try {
      await session.manager.install('temidayoxyz/deep-contrast')
      await assert.rejects(
        () => session.manager.install('temidayoxyz/deep-contrast'),
        AlreadyInstalledError,
      )
    } finally {
      dispose(session)
    }
  })

  it('rejects invalid repository input before touching pnpm', async () => {
    const session = makeSession({ 'temidayoxyz/deep-contrast': contrast })
    try {
      await assert.rejects(() => session.manager.install('not a repo; rm -rf /'), InvalidRefError)
      assert.equal(session.runner.calls.length, 0)
    } finally {
      dispose(session)
    }
  })
})

describe('enable and disable', () => {
  it('disables without uninstalling, then re-enables', async () => {
    const session = makeSession({ 'temidayoxyz/deep-contrast': contrast })
    try {
      await session.manager.install('temidayoxyz/deep-contrast')
      session.manager.disable('dsh-deep-contrast')
      let state = readState(session.profileDir)
      assert.deepEqual(state.bundles, [])
      assert.equal(state.dependencies['dsh-deep-contrast'], 'github:temidayoxyz/deep-contrast')
      assert.ok(existsSync(join(session.profileDir, 'node_modules', 'dsh-deep-contrast', 'package.json')))
      session.manager.enable('dsh-deep-contrast')
      state = readState(session.profileDir)
      assert.deepEqual(state.bundles, ['dsh-deep-contrast'])
    } finally {
      dispose(session)
    }
  })

  it('refuses unknown and reserved names', async () => {
    const session = makeSession({ 'temidayoxyz/deep-contrast': contrast })
    try {
      await session.manager.install('temidayoxyz/deep-contrast')
      assert.throws(() => session.manager.enable('dsh-not-installed'), NotInstalledError)
      assert.throws(() => session.manager.disable('@deepseek-ai/dsh-base'), ReservedNameError)
      assert.throws(() => session.manager.disable('dsh-deep-plugin-manager'), ReservedNameError)
    } finally {
      dispose(session)
    }
  })

  it('enable of an installed-but-enabled plugin is idempotent', async () => {
    const session = makeSession({ 'temidayoxyz/deep-contrast': contrast })
    try {
      await session.manager.install('temidayoxyz/deep-contrast')
      session.manager.enable('dsh-deep-contrast')
      assert.deepEqual(readState(session.profileDir).bundles, ['dsh-deep-contrast'])
    } finally {
      dispose(session)
    }
  })
})

describe('uninstall', () => {
  it('removes the package and its bundle entry', async () => {
    const session = makeSession({ 'temidayoxyz/deep-contrast': contrast })
    try {
      await session.manager.install('temidayoxyz/deep-contrast')
      await session.manager.uninstall('dsh-deep-contrast')
      const state = readState(session.profileDir)
      assert.equal(state.dependencies['dsh-deep-contrast'], undefined)
      assert.deepEqual(state.bundles, [])
      assert.equal(existsSync(join(session.profileDir, 'node_modules', 'dsh-deep-contrast')), false)
    } finally {
      dispose(session)
    }
  })

  it('restores the enabled state when pnpm removal fails', async () => {
    const session = makeSession(
      { 'temidayoxyz/deep-contrast': contrast },
      { failRemoveWith: 'EPERM: file in use' },
    )
    try {
      await session.manager.install('temidayoxyz/deep-contrast')
      await assert.rejects(() => session.manager.uninstall('dsh-deep-contrast'), ManagerError)
      const state = readState(session.profileDir)
      assert.equal(state.dependencies['dsh-deep-contrast'], 'github:temidayoxyz/deep-contrast')
      assert.deepEqual(state.bundles, ['dsh-deep-contrast'])
    } finally {
      dispose(session)
    }
  })

  it('refuses to uninstall a plugin that is not installed', async () => {
    const session = makeSession({})
    try {
      await assert.rejects(() => session.manager.uninstall('dsh-ghost'), NotInstalledError)
    } finally {
      dispose(session)
    }
  })
})

describe('update', () => {
  it('detects a newer release and updates while preserving state', async () => {
    const release = { tag: 'v0.2.0', name: '0.2.0', url: 'https://example.test/v0.2.0', publishedAt: '2026-09-13' }
    const session = makeSession(
      { 'temidayoxyz/deep-contrast': contrast, 'temidayoxyz/deep-tariff': tariff },
      { latestRelease: release },
    )
    try {
      await session.manager.install('temidayoxyz/deep-contrast')
      await session.manager.install('temidayoxyz/deep-tariff')
      session.manager.disable('dsh-deep-contrast')

      const check = await session.manager.checkUpdate('dsh-deep-contrast')
      assert.equal(check.updateAvailable, true)
      assert.equal(check.latest?.tag, 'v0.2.0')

      // The fake materializes whatever spec it is asked for as the catalog's
      // current version, so the pinned re-add lands 0.2.0.
      const result = await session.manager.update('dsh-deep-contrast')
      assert.equal(result.version, '0.2.0')
      assert.equal(readInstalledVersion(session.profileDir, 'dsh-deep-contrast'), '0.2.0')
      const state = readState(session.profileDir)
      assert.deepEqual(state.bundles, ['dsh-deep-tariff'], 'disabled state survives an update; siblings keep theirs')
      assert.equal(state.dependencies['dsh-deep-tariff'], 'github:temidayoxyz/deep-tariff', 'siblings untouched')
    } finally {
      dispose(session)
    }
  })

  it('reports up-to-date without running package operations', async () => {
    const release = { tag: 'v0.1.0', name: '0.1.0', url: '', publishedAt: '' }
    const session = makeSession({ 'temidayoxyz/deep-contrast': contrast }, { latestRelease: release })
    try {
      await session.manager.install('temidayoxyz/deep-contrast')
      const callsBefore = session.runner.calls.length
      const check = await session.manager.checkUpdate('dsh-deep-contrast')
      assert.equal(check.updateAvailable, false)
      const result = await session.manager.update('dsh-deep-contrast')
      assert.equal(result.version, '0.1.0')
      assert.equal(session.runner.calls.length, callsBefore)
    } finally {
      dispose(session)
    }
  })

  it('leaves the old installation intact when a failed update is attempted', async () => {
    const release = { tag: 'v0.9.0', name: '0.9.0', url: '', publishedAt: '' }
    const session = makeSession(
      { 'temidayoxyz/deep-contrast': contrast },
      {
        latestRelease: release,
        runnerOverride: (args) => args[0] === 'add' && (args[1] ?? '').includes('#v0.9.0')
          ? { code: 1, output: 'cannot resolve the pinned version' }
          : undefined,
      },
    )
    try {
      await session.manager.install('temidayoxyz/deep-contrast')
      await assert.rejects(() => session.manager.update('dsh-deep-contrast'), ManagerError)
      const state = readState(session.profileDir)
      assert.equal(state.dependencies['dsh-deep-contrast'], 'github:temidayoxyz/deep-contrast')
      assert.equal(readInstalledVersion(session.profileDir, 'dsh-deep-contrast'), '0.1.0')
      assert.deepEqual(state.bundles, ['dsh-deep-contrast'])
    } finally {
      dispose(session)
    }
  })
})

describe('coexistence', () => {
  it('manages two plugins without cross-interference', async () => {
    const session = makeSession({ 'temidayoxyz/deep-contrast': contrast, 'temidayoxyz/deep-tariff': tariff })
    try {
      await session.manager.install('temidayoxyz/deep-contrast')
      await session.manager.install('temidayoxyz/deep-tariff')
      session.manager.disable('dsh-deep-contrast')
      let plugins = session.manager.list()
      assert.equal(plugins.length, 2)
      assert.equal(plugins.find((entry) => entry.name === 'dsh-deep-contrast')?.enabled, false)
      assert.equal(plugins.find((entry) => entry.name === 'dsh-deep-tariff')?.enabled, true)
      await session.manager.uninstall('dsh-deep-tariff')
      plugins = session.manager.list()
      assert.equal(plugins.length, 1)
      assert.equal(plugins[0]?.name, 'dsh-deep-contrast')
      const state = readState(session.profileDir)
      assert.deepEqual(state.bundles, [])
    } finally {
      dispose(session)
    }
  })
})
