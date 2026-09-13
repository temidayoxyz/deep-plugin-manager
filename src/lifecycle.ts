/**
 * The lifecycle engine: Discover → Install → Enable → Disable → Update →
 * Uninstall, implemented entirely over the Harness's own state. The profile
 * manifest (`dependencies` + `dsh.profile.bundles`) is the single source of
 * truth; pnpm performs every package operation inside the profile directory,
 * the same way the `dsh plugin` CLI does. There is no parallel registry to
 * fall out of sync.
 *
 * Safety model:
 * - Install validates the fetched package against the Harness plugin contract
   (`dsh.bundle.patch` in its manifest) and rolls the package back out when
   it does not qualify, so an invalid repository never lingers.
 * - Enable/disable are manifest-only writes (atomic temp+rename) and take
   effect at the next Harness start; the UI says so.
 * - Uninstall removes the bundle entry first, then the package; if pnpm
   fails, the bundle entry is restored so state stays consistent.
 * - Update re-pins the dependency spec; a failed pnpm run changes nothing.
 * - Harness-owned packages and the manager itself are refused everywhere.
 *
 * @module dsh-deep-plugin-manager/lifecycle
 */
import {
  AlreadyInstalledError,
  InvalidRefError,
  ManagerError,
  NotAPluginError,
  NotInstalledError,
} from './errors.ts'
import {
  latestRelease, isNewerVersion, parseRepoRef, repoFromSpec, specFor,
  type ReleaseInfo, type RepoRef,
} from './github.ts'
import {
  assertManageableName, listPlugins, readInstalledPackage, readManifest, writeManifest,
  type PluginEntry, type ProfileManifest,
} from './profile.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPnpm, type PnpmRunner } from './runner.ts'

/** One listed plugin plus the patch-layer mount fact the UI renders. */
export type ManagedEntry = PluginEntry & { patchMounted: boolean }

/**
 * Whether an inserted module name mounts one package: equal to it, or a
 * subpath of it (`pkg/client`). Compared in place; nothing is concatenated.
 */
function mountsPackage(mounted: string, name: string): boolean {
  if (mounted === name) return true
  return mounted.indexOf(name) === 0 && mounted.charAt(name.length) === '/'
}

/**
 * Scan the profile's `cordis.patch.yml` user layer for inserted module names.
 * A plugin mounted this way is active without being in the bundle list, so
 * bundle membership alone would misreport its state, and an enable/disable
 * through the bundle list would silently no-op. The scan is a deliberate
 * line heuristic (insert rows carry `name: <package>`), enough for status
 * display and the guard below.
 * @param profileDir - the profile directory.
 * @returns the inserted module names (bare package names and subpaths).
 */
function readPatchMountedNames(profileDir: string): string[] {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) return []
  const names: string[] = []
  for (const line of readFileSync(patchPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('name: ') === false) continue
    const value = trimmed.slice('name: '.length).trim()
    if (value !== '') names.push(value)
  }
  return names
}

/**
 * Whether one package is mounted through the profile's patch layer.
 * @param profileDir - the profile directory.
 * @param name - package name.
 * @returns whether the patch layer mounts the package.
 */
function isPatchMounted(profileDir: string, name: string): boolean {
  return readPatchMountedNames(profileDir).some((mounted) => mountsPackage(mounted, name))
}

/**
 * Refuse enable/disable for a plugin the patch layer mounts: the bundle list
 * does not control it, so the toggle would silently do nothing.
 * @param profileDir - the profile directory.
 * @param name - package name.
 * @throws {ManagerError} with a pointer to the patch file when mounted.
 */
function assertNotPatchMounted(profileDir: string, name: string): void {
  if (isPatchMounted(profileDir, name)) {
    throw new ManagerError(
      'patch-managed',
      `"${name}" is mounted through the profile's cordis.patch.yml — enable or disable it there.`,
      409,
    )
  }
}

/** Result of one successful install. */
export interface InstallResult {
  name: string
  version: string
  spec: string
  /** Whether the user must restart the Harness to load the plugin (always true). */
  restartRequired: true
}

/** Result of an update check. */
export interface UpdateCheck {
  name: string
  /** Installed version, when the package is materialized. */
  current: string
  /** Latest GitHub release, when the repository publishes releases. */
  latest: ReleaseInfo | null
  /** Whether the latest release is newer than the installed version. */
  updateAvailable: boolean
  /** Release URL, when a release exists. */
  releaseUrl?: string
}

/** Result of one successful update. */
export interface UpdateResult {
  name: string
  /** The version (or tag) now installed. */
  version: string
  restartRequired: true
}

/** Dependencies of the lifecycle engine; all injectable for tests. */
export interface PluginManagerOptions {
  /** The Harness profile directory this manager runs for. */
  profileDir: string
  /** The pnpm runner (injectable; tests substitute a fake). */
  runner: PnpmRunner
  /** Injected GitHub release lookup (tests substitute a fake). */
  latestReleaseFn?: typeof latestRelease
}

/**
 * Create the lifecycle manager bound to one profile directory.
 * @param options - profile directory, pnpm runner, optional GitHub override.
 * @returns the manager operations.
 */
export function createPluginManager(options: PluginManagerOptions): {
  list(): ManagedEntry[]
  install(input: string): Promise<InstallResult>
  enable(name: string): void
  disable(name: string): void
  uninstall(name: string): Promise<void>
  checkUpdate(name: string): Promise<UpdateCheck>
  update(name: string): Promise<UpdateResult>
} {
  const { profileDir, runner } = options
  const releaseLookup = options.latestReleaseFn ?? latestRelease

  const dependencyNames = (manifest: ProfileManifest): string[] =>
    Object.keys(manifest.dependencies ?? {})

  /** Remove one dependency through pnpm; failures surface as RunnerError. */
  const removePackage = async (name: string): Promise<void> => {
    await runPnpm(runner, profileDir, ['remove', name], `remove ${name}`)
  }

  return {
    list(): ManagedEntry[] {
      return listPlugins(profileDir).map((entry) => ({
        ...entry,
        patchMounted: isPatchMounted(profileDir, entry.name),
      }))
    },

    async install(input: string): Promise<InstallResult> {
      const ref: RepoRef = parseRepoRef(input)
      const spec = specFor(ref)
      const before = readManifest(profileDir)
      const beforeNames = new Set(dependencyNames(before))

      // pnpm performs fetch, build, and manifest update; a failure here
      // leaves no dependency behind (pnpm is transactional for add).
      await runPnpm(runner, profileDir, ['add', spec], `install ${spec}`)

      const after = readManifest(profileDir)
      const added = dependencyNames(after).filter((name) => !beforeNames.has(name))
      if (added.length === 0) {
        // pnpm resolved the add against an existing dependency: either the
        // plugin is already installed or the spec re-pointed an existing one.
        const existing = dependencyNames(after).find((name) => after.dependencies?.[name] === spec)
        if (existing !== undefined) throw new AlreadyInstalledError(existing)
        throw new ManagerError('install-empty', 'The install produced no new package.', 500)
      }

      let name: string
      try {
        if (added.length !== 1) {
          throw new ManagerError(
            'install-empty',
            `The install yielded ${String(added.length)} top-level packages; expected exactly one.`,
            500,
          )
        }
        const candidate = added[0] ?? ''
        assertManageableName(candidate)
        const installed = readInstalledPackage(profileDir, candidate)
        if (installed.bundlePatch === undefined) {
          throw new NotAPluginError(
            `"${candidate}" is not a DeepSeek Harness plugin: its package.json declares no dsh.bundle.patch.`,
          )
        }
        name = candidate
      } catch (error) {
        // Not a plugin (or unmanageable): roll the package back out so the
        // profile never keeps a rejected dependency.
        writeManifest(profileDir, before)
        for (const addedName of added) {
          await removePackage(addedName).catch(() => undefined)
        }
        throw error
      }

      enableInManifest(profileDir, name)
      const installed = readInstalledPackage(profileDir, name)
      return {
        name,
        version: installed.version,
        spec: after.dependencies?.[name] ?? spec,
        restartRequired: true,
      }
    },

    enable(name: string): void {
      assertManageableName(name)
      const manifest = readManifest(profileDir)
      if (!Object.hasOwn(manifest.dependencies ?? {}, name)) throw new NotInstalledError(name)
      assertNotPatchMounted(profileDir, name)
      const bundles = manifest.dsh?.profile?.bundles ?? []
      if (bundles.includes(name)) return
      writeManifest(profileDir, {
        ...manifest,
        dsh: {
          ...manifest.dsh,
          profile: { ...manifest.dsh?.profile, bundles: [...bundles, name] },
        },
      })
    },

    disable(name: string): void {
      assertManageableName(name)
      const manifest = readManifest(profileDir)
      if (!Object.hasOwn(manifest.dependencies ?? {}, name)) throw new NotInstalledError(name)
      assertNotPatchMounted(profileDir, name)
      const bundles = manifest.dsh?.profile?.bundles ?? []
      if (!bundles.includes(name)) return
      writeManifest(profileDir, {
        ...manifest,
        dsh: {
          ...manifest.dsh,
          profile: { ...manifest.dsh?.profile, bundles: bundles.filter((entry) => entry !== name) },
        },
      })
    },

    async uninstall(name: string): Promise<void> {
      assertManageableName(name)
      const manifest = readManifest(profileDir)
      if (!Object.hasOwn(manifest.dependencies ?? {}, name)) throw new NotInstalledError(name)
      const bundles = manifest.dsh?.profile?.bundles ?? []
      const wasEnabled = bundles.includes(name)
      if (wasEnabled) {
        // Detach first: if the removal below fails, the plugin is merely
        // disabled, and the bundle entry is restored on the error path.
        writeManifest(profileDir, {
          ...manifest,
          dsh: {
            ...manifest.dsh,
            profile: { ...manifest.dsh?.profile, bundles: bundles.filter((entry) => entry !== name) },
          },
        })
      }
      try {
        await removePackage(name)
      } catch (error) {
        if (wasEnabled) {
          const current = readManifest(profileDir)
          writeManifest(profileDir, {
            ...current,
            dsh: {
              ...current.dsh,
              profile: { ...current.dsh?.profile, bundles: [...(current.dsh?.profile?.bundles ?? []), name] },
            },
          })
        }
        throw error
      }
    },

    async checkUpdate(name: string): Promise<UpdateCheck> {
      const spec = specOf(name)
      const repo = repoFromSpec(spec)
      if (repo === undefined) {
        throw new InvalidRefError(`"${name}" was not installed from GitHub, so there is nothing to check.`)
      }
      const current = readInstalledPackage(profileDir, name).version
      const latest = await releaseLookup(repo)
      if (latest === null) {
        return { name, current, latest: null, updateAvailable: false }
      }
      return {
        name,
        current,
        latest,
        updateAvailable: isNewerVersion(current, latest.tag),
        ...(latest.url === undefined ? {} : { releaseUrl: latest.url }),
      }
    },

    async update(name: string): Promise<UpdateResult> {
      assertManageableName(name)
      const spec = specOf(name)
      const repo: RepoRef | undefined = repoFromSpec(spec)
      if (repo === undefined) {
        throw new InvalidRefError(`"${name}" was not installed from GitHub, so it cannot be updated here.`)
      }
      const current = readInstalledPackage(profileDir, name).version
      const latest = await releaseLookup(repo)
      let target: string
      if (latest === null) {
        // No releases: refresh to the newest commit of the pinned (or default)
        // branch by re-adding the same spec.
        target = spec
        await runPnpm(runner, profileDir, ['add', spec], `update ${name}`)
      } else if (!isNewerVersion(current, latest.tag)) {
        return { name, version: current, restartRequired: true }
      } else {
        // Pin updates to published releases for stability; keep the user's
        // own ref when they installed onto a branch deliberately.
        target = repo.ref !== undefined ? spec : specFor({ ...repo, ref: latest.tag })
        await runPnpm(runner, profileDir, ['add', target], `update ${name} to ${latest.tag}`)
      }
      return { name, version: readInstalledPackage(profileDir, name).version || target, restartRequired: true }
    },
  }

  /** Dependency spec of one installed plugin, from the profile manifest. */
  function specOf(name: string): string {
    const manifest = readManifest(profileDir)
    const spec = manifest.dependencies?.[name]
    if (spec === undefined) throw new NotInstalledError(name)
    return spec
  }

  /** Add one plugin to the enabled bundle list when it is not listed yet. */
  function enableInManifest(dir: string, pluginName: string): void {
    const manifest = readManifest(dir)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (bundles.includes(pluginName)) return
    writeManifest(dir, {
      ...manifest,
      dsh: {
        ...manifest.dsh,
        profile: { ...manifest.dsh?.profile, bundles: [...bundles, pluginName] },
      },
    })
  }
}
