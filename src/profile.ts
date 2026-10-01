/**
 * The profile is the Harness's own plugin state: one `package.json` whose
 * `dependencies` hold installed plugins and whose `dsh.profile.bundles` holds
 * the enabled subset. Deep Plugin Manager keeps zero state of its own — every
 * read and write here is the Harness's source of truth, written the same way
 * the `dsh plugin` CLI and the desktop manager write it.
 *
 * @module dsh-deep-plugin-manager/profile
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ManagerError, NotInstalledError, ReservedNameError } from './errors.ts'

/** Packages the Harness owns; the manager refuses to touch them. */
const RESERVED_PREFIXES = ['@deepseek-ai/']

/** This manager's own package name. */
export const SELF_NAME = 'dsh-deep-plugin-manager'

/** A 40-character git SHA, as pnpm records one in a lockfile tarball URL. */
const COMMIT_SHA = /\b([0-9a-f]{40})\b/

/** The `dsh.profile` slice of the profile manifest. */
export interface ProfileManifest {
  name?: string
  private?: boolean
  version?: string
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
      patchReload?: string
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** One installed plugin as the manager reports it. */
export interface PluginEntry {
  /** Package name (the manifest dependency key). */
  name: string
  /** Installed package version. */
  version: string
  /** Dependency spec as written in the profile manifest (e.g. `github:o/r#v1.2.0`). */
  spec: string
  /** Whether the package is in `dsh.profile.bundles` (loaded at next boot). */
  enabled: boolean
  /** Package description, when the plugin declares one. */
  description?: string
  /** Repository URL from the plugin's own manifest, when declared. */
  repository?: string
  /** Author field from the plugin's own manifest, when declared. */
  author?: string
}

/** Whether a package name belongs to the Harness core or to this manager. */
export function isReservedName(name: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)) || name === 'dsh-deep-plugin-manager'
}

/**
 * Locate the profile directory this plugin runs from. Two strategies, in
 * order:
 * 1. Walk up from the module URL to the nearest ancestor whose
 *    `package.json` declares `dsh.profile` — the copied/hoisted install case.
 *    The walk follows the un-realpathed module path so ordinary pnpm
 *    junctions keep pointing back at the profile.
 * 2. When that fails (a `link:` install resolves `import.meta.url` to the
 *    source checkout), scan the profiles root for the profile whose
 *    `node_modules` contains this package.
 * @param moduleUrl - `import.meta.url` of the compiled host entry.
 * @param profilesRoot - the Harness home's `profiles` directory
 *   (`dshHomePath('profiles')`), for strategy 2.
 * @returns the profile directory.
 * @throws {ManagerError} when no strategy identifies a profile.
 */
export function resolveProfileDir(moduleUrl: string, profilesRoot?: string): string {
  const selfName = nearestManifestName(fileURLToPath(moduleUrl))
  let dir = dirname(fileURLToPath(moduleUrl))
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest
        if (parsed.dsh !== undefined && typeof parsed.dsh === 'object'
          && parsed.dsh.profile !== undefined && typeof parsed.dsh.profile === 'object') {
          return dir
        }
      } catch {
        // Unreadable ancestor manifest: keep walking toward the profile root.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (selfName !== undefined && profilesRoot !== undefined && profilesRoot !== '') {
    if (existsSync(profilesRoot)) {
      for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = join(profilesRoot, entry.name)
        if (existsSync(join(candidate, 'node_modules', ...selfName.split('/'), 'package.json'))) {
          return candidate
        }
      }
    }
  }
  throw new ManagerError(
    'profile-not-found',
    'Deep Plugin Manager could not locate the Harness profile directory it runs from.',
    500,
  )
}

/**
 * Read the `name` of the nearest ancestor package manifest (this plugin's
 * own manifest), used to identify the installing profile during the home
 * scan.
 * @param startFile - a file path inside the package.
 * @returns the package name, or undefined when no manifest is readable.
 */
function nearestManifestName(startFile: string): string | undefined {
  let dir = dirname(startFile)
  for (let depth = 0; depth < 6; depth += 1) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
        if (typeof parsed.name === 'string') return parsed.name
      } catch {
        return undefined
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * Read and structurally validate the profile manifest.
 * @param profileDir - the profile directory.
 * @returns the parsed manifest.
 * @throws {ManagerError} when the manifest is missing or not a JSON object.
 */
export function readManifest(profileDir: string): ProfileManifest {
  const path = join(profileDir, 'package.json')
  if (!existsSync(path)) {
    throw new ManagerError('profile-not-found', `No profile manifest at ${path}.`, 500)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ManagerError('manifest-corrupt', 'The profile manifest is not valid JSON.', 500, String(error))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ManagerError('manifest-corrupt', 'The profile manifest must be a JSON object.', 500)
  }
  return parsed as ProfileManifest
}

/**
 * Write the profile manifest atomically (temp file + rename) so a crash mid
 * write cannot leave a truncated manifest.
 * @param profileDir - the profile directory.
 * @param manifest - the full manifest to persist.
 */
export function writeManifest(profileDir: string, manifest: ProfileManifest): void {
  const path = join(profileDir, 'package.json')
  const temp = `${path}.dpm-tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(temp, `${JSON.stringify(manifest, undefined, 2)}\n`)
  renameSync(temp, path)
}

/**
 * List the profile's installed plugins, derived entirely from the profile
 * manifest plus each installed package's own manifest.
 * @param profileDir - the profile directory.
 * @returns plugin entries sorted by name; Harness-owned packages are excluded.
 */
export function listPlugins(profileDir: string): PluginEntry[] {
  const manifest = readManifest(profileDir)
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
  const entries: PluginEntry[] = []
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (isReservedName(name)) continue
    const manifestPath = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(manifestPath)) {
      // Declared but not materialized (interrupted install): report it so the
      // UI can surface the broken state instead of hiding it.
      entries.push({ name, version: '', spec, enabled: bundles.has(name) })
      continue
    }
    try {
      const installed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        version?: unknown
        description?: unknown
        author?: unknown
        repository?: unknown
      }
      entries.push({
        name,
        version: typeof installed.version === 'string' ? installed.version : '',
        spec,
        enabled: bundles.has(name),
        description: typeof installed.description === 'string' ? installed.description : undefined,
        author: typeof installed.author === 'string' ? installed.author : undefined,
        repository: typeof installed.repository === 'object' && installed.repository !== null
          && typeof (installed.repository as { url?: unknown }).url === 'string'
          ? (installed.repository as { url: string }).url
          : typeof installed.repository === 'string' ? installed.repository : undefined,
      })
    } catch {
      entries.push({ name, version: '', spec, enabled: bundles.has(name) })
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Read one installed plugin's own manifest.
 * @param profileDir - the profile directory.
 * @param name - package name.
 * @returns `{ version, bundlePatch }` when the package is installed.
 * @throws {NotInstalledError} when the package is not materialized.
 */
export function readInstalledPackage(
  profileDir: string,
  name: string,
): { version: string; bundlePatch?: string } {
  const manifestPath = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
  if (!existsSync(manifestPath)) throw new NotInstalledError(name)
  const installed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version?: unknown
    dsh?: { bundle?: { patch?: unknown } }
  }
  return {
    version: typeof installed.version === 'string' ? installed.version : '',
    bundlePatch: typeof installed.dsh?.bundle?.patch === 'string' ? installed.dsh.bundle.patch : undefined,
  }
}

/** Leading indentation width of one YAML line, used for block scoping. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * Read the commit pnpm actually installed for one GitHub dependency.
 *
 * pnpm resolves a `github:` spec to a codeload tarball URL whose last path
 * segment is the exact commit, and records it in `pnpm-lock.yaml` under the
 * root importer:
 *
 * ```yaml
 * dsh-deep-plugin-manager:
 *   specifier: github:temidayoxyz/deep-plugin-manager
 *   version: https://codeload.github.com/owner/repo/tar.gz/<sha>
 * ```
 *
 * That recorded SHA is the authoritative answer to "which commit is installed",
 * so a release-less repository can still be compared against its branch head.
 * The lockfile is pnpm's own file rather than the profile manifest, so the read
 * is deliberately forgiving: the root importer block is located by indentation,
 * the dependency's own two lines are read, and anything unrecognized yields
 * `undefined` ("cannot compare") instead of a guess.
 *
 * @param profileDir - the profile directory.
 * @param name - dependency name (the package name, which is the lockfile key).
 * @returns the installed commit SHA, or undefined when it cannot be determined.
 */
export function installedCommit(profileDir: string, name: string): string | undefined {
  const lockPath = join(profileDir, 'pnpm-lock.yaml')
  if (!existsSync(lockPath)) return undefined
  let lines: string[]
  try {
    lines = readFileSync(lockPath, 'utf8').split(/\r?\n/)
  } catch {
    return undefined
  }

  // Scope to the root importer (`  .:`), the one that holds the profile's own
  // dependencies; a workspace member's block must not answer for the profile.
  const importersAt = lines.findIndex((line) => line.trimEnd() === 'importers:')
  if (importersAt === -1) return undefined
  let rootAt = -1
  let rootIndent = 0
  for (let index = importersAt + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (line.trimEnd().startsWith('importers:')) break
    // The root importer is the `.:` key at the shallowest indent under
    // `importers:`; stop once a shallower line appears.
    if (rootAt === -1) {
      if (line.trim() === '.:' || line.trim() === "'.':") {
        rootAt = index
        rootIndent = indent
      }
      continue
    }
    if (indent <= rootIndent) break
  }
  if (rootAt === -1) return undefined

  // Within the root block, find this dependency's `specifier`/`version` pair.
  const quotedName = `'${name}'`
  for (let index = rootAt + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    if (indentOf(line) <= rootIndent) break
    if (line.trim() !== `${name}:` && line.trim() !== `${quotedName}:`) continue
    let specifier = ''
    let version = ''
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const innerLine = lines[inner] ?? ''
      if (innerLine.trim() === '') continue
      if (indentOf(innerLine) <= indentOf(line)) break
      const specifierMatch = /^specifier:\s*(.+)$/.exec(innerLine.trim())
      if (specifierMatch?.[1] !== undefined) specifier = specifierMatch[1].trim()
      const versionMatch = /^version:\s*(.+)$/.exec(innerLine.trim())
      if (versionMatch?.[1] !== undefined) {
        version = versionMatch[1].trim().replaceAll("'", '')
        break
      }
    }
    if (specifier === '' || !specifier.startsWith('github:')) return undefined
    const sha = COMMIT_SHA.exec(version)?.[1]
    return sha
  }
  return undefined
}

/**
 * Assert a name may be managed: not Harness-reserved, not the manager itself.
 * @param name - package name.
 * @throws {ReservedNameError} when the name is owned by the Harness or self.
 */
export function assertManageableName(name: string): void {
  if (isReservedName(name)) throw new ReservedNameError(name)
}
