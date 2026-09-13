/**
 * The GitHub layer: reference parsing, host validation, and release lookups.
 * Server requests go only to the public GitHub hosts over https — localhost,
 * loopback, private, and reserved addresses are rejected before any request.
 * Authentication is optional: when `GITHUB_TOKEN` (or `GH_TOKEN`) is present
 * in the environment it rides the API request, raising the rate limit for
 * private-repo support later; public repositories never require it.
 *
 * @module dsh-deep-plugin-manager/github
 */
import { GitHubError, InvalidRefError } from './errors.ts'

/** A parsed, validated GitHub repository reference. */
export interface RepoRef {
  owner: string
  repo: string
  /** Optional tag/branch pin the user asked for. */
  ref?: string
}

/** One GitHub release as the manager surfaces it. */
export interface ReleaseInfo {
  tag: string
  name: string
  url: string
  publishedAt: string
}

/** GitHub owner/repository names allow letters, digits, dots, hyphens, underscores. */
const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** Git refs are restricted to this subset: no spaces, no shell characters. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** The assembled pnpm spec must stay inside this charset: it later rides a
    spawned pnpm command line, whose Windows path goes through a shell. */
const SAFE_SPEC = /^[A-Za-z0-9@/:._#-]+$/

/** Hosts the manager may contact; anything else is refused before fetch. */
const ALLOWED_HOSTS = new Set(['api.github.com', 'github.com', 'codeload.github.com'])

/**
 * Parse a user-supplied GitHub reference. Accepted shapes:
 * `owner/repo`, `owner/repo#ref`, `https://github.com/owner/repo(.git)`,
 * `https://github.com/owner/repo/tree/<ref>`, `github:owner/repo[#ref]`.
 * Every segment is validated before any downstream use, so nothing derived
 * from user input can carry shell metacharacters into a spawned command.
 * @param input - raw user input.
 * @returns the parsed reference.
 * @throws {InvalidRefError} when the input is not a recognizable public
 * GitHub repository reference.
 */
export function parseRepoRef(input: string): RepoRef {
  const raw = input.trim()
  if (raw === '') throw new InvalidRefError('Enter a GitHub repository as owner/repo or a github.com URL.')

  let rest = raw
  let ref: string | undefined

  const hashAt = rest.indexOf('#')
  if (hashAt !== -1) {
    ref = rest.slice(hashAt + 1).trim()
    rest = rest.slice(0, hashAt).trim()
    if (ref === '') throw new InvalidRefError('The reference after "#" is empty.')
  }

  if (rest.startsWith('github:')) rest = rest.slice('github:'.length)
  let segments: string[]
  if (rest.startsWith('https://')) {
    let url: URL
    try {
      url = new URL(rest)
    } catch {
      throw new InvalidRefError(`"${raw}" is not a valid URL.`)
    }
    if (url.protocol !== 'https:') throw new InvalidRefError('Only https GitHub URLs are supported.')
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new InvalidRefError(`"${url.hostname}" is not a GitHub host. Use owner/repo or a github.com URL.`)
    }
    segments = url.pathname.split('/').filter((segment) => segment !== '')
    if (segments[1]?.endsWith('.git')) {
      segments[1] = segments[1].slice(0, -'.git'.length)
    }
    const treeAt = segments.indexOf('tree')
    if (treeAt !== -1) {
      ref ??= segments.slice(treeAt + 1).join('/')
      segments = segments.slice(0, treeAt)
    }
  } else {
    segments = rest.split('/')
  }

  if (segments.length !== 2) {
    throw new InvalidRefError(`"${raw}" is not owner/repo. Example: temidayoxyz/deep-contrast.`)
  }
  const owner = segments[0]?.trim() ?? ''
  const repo = segments[1]?.trim() ?? ''
  if (!OWNER_REPO.test(owner) || !OWNER_REPO.test(repo)) {
    throw new InvalidRefError(`"${owner}/${repo}" is not a valid GitHub owner/repository pair.`)
  }
  if (ref !== undefined && !SAFE_REF.test(ref)) {
    throw new InvalidRefError(
      `"${ref}" is not a usable git reference (allowed: letters, digits, and . _ / -).`,
    )
  }
  const parsed: RepoRef = { owner, repo, ...(ref === undefined ? {} : { ref }) }
  return parsed
}

/**
 * Build the pnpm dependency spec for one reference: the `github:` scheme,
 * the validated owner/repository segments, and the `#ref` pin when one was
 * asked for. Assembly uses only pre-validated segments, and the finished
 * argument is checked once more against the safe command-line charset — the
 * spec later rides a spawned pnpm command line whose Windows path goes
 * through a shell, so no shell metacharacter may survive to spawn.
 * @param ref - parsed reference.
 * @returns the pnpm spec.
 * @throws {InvalidRefError} when any segment falls outside the safe charset.
 */
export function specFor(ref: RepoRef): string {
  const segments = ['github:', ref.owner, '/', ref.repo]
  if (ref.ref !== undefined) segments.push('#', ref.ref)
  const spec = segments.join('')
  if (!SAFE_SPEC.test(spec)) {
    throw new InvalidRefError(
      'The repository reference contains characters outside the allowed set (letters, digits, and @ / : . _ # -).',
    )
  }
  return spec
}

/**
 * Extract the repository identity from an existing pnpm github spec, so
 * update checks and re-installs work from what the profile manifest records.
 * @param spec - dependency spec from the profile manifest.
 * @returns the parsed reference, or undefined for non-github specs.
 */
export function repoFromSpec(spec: string): RepoRef | undefined {
  if (!spec.startsWith('github:')) return undefined
  try {
    return parseRepoRef(spec)
  } catch {
    return undefined
  }
}

/**
 * Optional GitHub auth header from the environment. Public repositories never
 * require this; a present token only raises the API rate limit.
 * @returns the Authorization header value, or undefined.
 */
function authHeader(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  return token === undefined || token === ''
    ? {}
    : { authorization: `Bearer ${token}` }
}

/**
 * Validate a request URL against the allowlist before any network work:
 * https only, GitHub hosts only — no localhost, loopback, private, or
 * reserved addresses by construction.
 * @param url - the URL about to be fetched.
 * @throws {GitHubError} when the URL is not an allowed https GitHub host.
 */
function assertAllowedUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new GitHubError(`Refusing malformed request URL: ${url}`)
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new GitHubError(`Refusing request to non-GitHub host: ${parsed.hostname}`)
  }
}

/**
 * Fetch the repository's latest published release.
 * @param ref - repository reference (the ref field is ignored here).
 * @returns release info, or `null` when the repository has no releases.
 * @throws {GitHubError} on network failure, rate limit, or non-OK responses.
 */
export async function latestRelease(ref: RepoRef): Promise<ReleaseInfo | null> {
  const url = ['https://api.github.com/repos', ref.owner, ref.repo, 'releases', 'latest'].join('/')
  assertAllowedUrl(url)
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-deep-plugin-manager',
        ...authHeader(),
      },
    })
  } catch (error) {
    throw new GitHubError(`GitHub request failed: ${String(error)}`, String(error))
  }
  if (response.status === 404) return null
  if (response.status === 403 || response.status === 429) {
    throw new GitHubError(
      'GitHub rate limit reached. Try again later, or set GITHUB_TOKEN to raise the limit.',
    )
  }
  if (!response.ok) {
    throw new GitHubError(`GitHub responded ${String(response.status)} for ${ref.owner}/${ref.repo}.`)
  }
  const body = await response.json().catch(() => null) as {
    tag_name?: unknown
    name?: unknown
    html_url?: unknown
    published_at?: unknown
  } | null
  if (body === null || typeof body.tag_name !== 'string') {
    throw new GitHubError('GitHub returned an unreadable release payload.')
  }
  return {
    tag: body.tag_name,
    name: typeof body.name === 'string' && body.name !== '' ? body.name : body.tag_name,
    url: typeof body.html_url === 'string'
      ? body.html_url
      : ['https://github.com', ref.owner, ref.repo, 'releases'].join('/'),
    publishedAt: typeof body.published_at === 'string' ? body.published_at : '',
  }
}

/**
 * Compare a release tag against an installed version. Both are stripped of a
 * leading `v` and compared numerically per dot segment when they look like
 * versions; mismatched shapes fall back to inequality.
 * @param installedTagOrVersion - currently installed version or tag.
 * @param latestTag - the latest release tag.
 * @returns whether `latestTag` is newer.
 */
export function isNewerVersion(installedTagOrVersion: string, latestTag: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/^v/i, '')
  const installed = normalize(installedTagOrVersion)
  const latest = normalize(latestTag)
  if (installed === latest) return false
  const installedParts = installed.split('.').map((part) => Number.parseInt(part, 10))
  const latestParts = latest.split('.').map((part) => Number.parseInt(part, 10))
  if (installedParts.every((part) => Number.isInteger(part))
    && latestParts.every((part) => Number.isInteger(part))) {
    const length = Math.max(installedParts.length, latestParts.length)
    for (let index = 0; index < length; index += 1) {
      const left = installedParts[index] ?? 0
      const right = latestParts[index] ?? 0
      if (left !== right) return right > left
    }
    return false
  }
  return installed !== latest
}
