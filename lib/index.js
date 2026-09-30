import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

//#region src/errors.ts
/**
* Typed failures mapped to HTTP status codes by the route layer. Every
* lifecycle failure carries a user-presentable message; pnpm output rides
* along (`detail`) so the UI can show the real cause without log diving.
*
* @module dsh-deep-plugin-manager/errors
*/
/** Base class: a failure with an HTTP status and a presentable message. */
var ManagerError = class extends Error {
	/** HTTP status the route layer should respond with. */
	status;
	/** Machine-readable kind for the client UI. */
	kind;
	/** Captured tool output (pnpm/git) that explains the failure, if any. */
	detail;
	/**
	* @param kind - machine-readable failure kind.
	* @param message - user-presentable message.
	* @param status - HTTP status for the route layer.
	* @param detail - captured tool output, when the failure came from a tool.
	*/
	constructor(kind, message, status, detail) {
		super(message);
		this.name = "ManagerError";
		this.kind = kind;
		this.status = status;
		this.detail = detail;
	}
};
/** A GitHub reference or repository the manager refuses to act on. */
var InvalidRefError = class extends ManagerError {
	constructor(message, detail) {
		super("invalid-ref", message, 400, detail);
	}
};
/** The repository resolved fine but is not a compatible Harness plugin. */
var NotAPluginError = class extends ManagerError {
	constructor(message, detail) {
		super("not-a-plugin", message, 400, detail);
	}
};
/** The requested plugin is not installed in this profile. */
var NotInstalledError = class extends ManagerError {
	constructor(name) {
		super("not-installed", `Plugin "${name}" is not installed in this profile.`, 404);
	}
};
/** The plugin is already installed (duplicate install attempt). */
var AlreadyInstalledError = class extends ManagerError {
	constructor(name) {
		super("already-installed", `Plugin "${name}" is already installed. Use update to move versions.`, 409);
	}
};
/** The name belongs to the Harness core or to the manager itself. */
var ReservedNameError = class extends ManagerError {
	constructor(name) {
		super("reserved-name", `"${name}" is a Harness-owned package and cannot be managed here.`, 403);
	}
};
/** pnpm (or another tool) failed; `detail` carries its output. */
var RunnerError = class extends ManagerError {
	constructor(message, detail) {
		super("runner-failed", message, 502, detail);
	}
};
/** GitHub was unreachable, rate-limited, or returned an error. */
var GitHubError = class extends ManagerError {
	constructor(message, detail) {
		super("github-failed", message, 502, detail);
	}
};

//#endregion
//#region src/github.ts
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
/** GitHub owner/repository names allow letters, digits, dots, hyphens, underscores. */
const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Git refs are restricted to this subset: no spaces, no shell characters. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** The assembled pnpm spec must stay inside this charset: it later rides a
spawned pnpm command line, whose Windows path goes through a shell. */
const SAFE_SPEC = /^[A-Za-z0-9@/:._#-]+$/;
/** Hosts the manager may contact; anything else is refused before fetch. */
const ALLOWED_HOSTS = new Set([
	"api.github.com",
	"github.com",
	"codeload.github.com"
]);
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
function parseRepoRef(input) {
	const raw = input.trim();
	if (raw === "") throw new InvalidRefError("Enter a GitHub repository as owner/repo or a github.com URL.");
	let rest = raw;
	let ref;
	const hashAt = rest.indexOf("#");
	if (hashAt !== -1) {
		ref = rest.slice(hashAt + 1).trim();
		rest = rest.slice(0, hashAt).trim();
		if (ref === "") throw new InvalidRefError("The reference after \"#\" is empty.");
	}
	if (rest.startsWith("github:")) rest = rest.slice(7);
	let segments;
	if (rest.startsWith("https://")) {
		let url;
		try {
			url = new URL(rest);
		} catch {
			throw new InvalidRefError(`"${raw}" is not a valid URL.`);
		}
		if (url.protocol !== "https:") throw new InvalidRefError("Only https GitHub URLs are supported.");
		if (!ALLOWED_HOSTS.has(url.hostname)) throw new InvalidRefError(`"${url.hostname}" is not a GitHub host. Use owner/repo or a github.com URL.`);
		segments = url.pathname.split("/").filter((segment) => segment !== "");
		if (segments[1]?.endsWith(".git")) segments[1] = segments[1].slice(0, -4);
		const treeAt = segments.indexOf("tree");
		if (treeAt !== -1) {
			ref ??= segments.slice(treeAt + 1).join("/");
			segments = segments.slice(0, treeAt);
		}
	} else segments = rest.split("/");
	if (segments.length !== 2) throw new InvalidRefError(`"${raw}" is not owner/repo. Example: temidayoxyz/deep-contrast.`);
	const owner = segments[0]?.trim() ?? "";
	const repo = segments[1]?.trim() ?? "";
	if (!OWNER_REPO.test(owner) || !OWNER_REPO.test(repo)) throw new InvalidRefError(`"${owner}/${repo}" is not a valid GitHub owner/repository pair.`);
	if (ref !== void 0 && !SAFE_REF.test(ref)) throw new InvalidRefError(`"${ref}" is not a usable git reference (allowed: letters, digits, and . _ / -).`);
	return {
		owner,
		repo,
		...ref === void 0 ? {} : { ref }
	};
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
function specFor(ref) {
	const segments = [
		"github:",
		ref.owner,
		"/",
		ref.repo
	];
	if (ref.ref !== void 0) segments.push("#", ref.ref);
	const spec = segments.join("");
	if (!SAFE_SPEC.test(spec)) throw new InvalidRefError("The repository reference contains characters outside the allowed set (letters, digits, and @ / : . _ # -).");
	return spec;
}
/**
* Extract the repository identity from an existing pnpm github spec, so
* update checks and re-installs work from what the profile manifest records.
* @param spec - dependency spec from the profile manifest.
* @returns the parsed reference, or undefined for non-github specs.
*/
function repoFromSpec(spec) {
	if (!spec.startsWith("github:")) return void 0;
	try {
		return parseRepoRef(spec);
	} catch {
		return;
	}
}
/**
* Optional GitHub auth header from the environment. Public repositories never
* require this; a present token only raises the API rate limit.
* @returns the Authorization header value, or undefined.
*/
function authHeader() {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	return token === void 0 || token === "" ? {} : { authorization: `Bearer ${token}` };
}
/**
* Validate a request URL against the allowlist before any network work:
* https only, GitHub hosts only — no localhost, loopback, private, or
* reserved addresses by construction.
* @param url - the URL about to be fetched.
* @throws {GitHubError} when the URL is not an allowed https GitHub host.
*/
function assertAllowedUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new GitHubError(`Refusing malformed request URL: ${url}`);
	}
	if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) throw new GitHubError(`Refusing request to non-GitHub host: ${parsed.hostname}`);
}
/**
* Fetch the repository's latest published release.
* @param ref - repository reference (the ref field is ignored here).
* @returns release info, or `null` when the repository has no releases.
* @throws {GitHubError} on network failure, rate limit, or non-OK responses.
*/
async function latestRelease(ref) {
	const url = [
		"https://api.github.com/repos",
		ref.owner,
		ref.repo,
		"releases",
		"latest"
	].join("/");
	assertAllowedUrl(url);
	let response;
	try {
		response = await fetch(url, { headers: {
			accept: "application/vnd.github+json",
			"user-agent": "dsh-deep-plugin-manager",
			...authHeader()
		} });
	} catch (error) {
		throw new GitHubError(`GitHub request failed: ${String(error)}`, String(error));
	}
	if (response.status === 404) return null;
	if (response.status === 403 || response.status === 429) throw new GitHubError("GitHub rate limit reached. Try again later, or set GITHUB_TOKEN to raise the limit.");
	if (!response.ok) throw new GitHubError(`GitHub responded ${String(response.status)} for ${ref.owner}/${ref.repo}.`);
	const body = await response.json().catch(() => null);
	if (body === null || typeof body.tag_name !== "string") throw new GitHubError("GitHub returned an unreadable release payload.");
	return {
		tag: body.tag_name,
		name: typeof body.name === "string" && body.name !== "" ? body.name : body.tag_name,
		url: typeof body.html_url === "string" ? body.html_url : [
			"https://github.com",
			ref.owner,
			ref.repo,
			"releases"
		].join("/"),
		publishedAt: typeof body.published_at === "string" ? body.published_at : ""
	};
}
/**
* Fetch the repository's own metadata (the About description).
* @param ref - repository reference (the ref field is ignored here).
* @returns metadata, or `null` when the repository does not exist.
* @throws {GitHubError} on network failure, rate limit, or non-OK responses.
*/
async function repoMetadata(ref) {
	const url = [
		"https://api.github.com/repos",
		ref.owner,
		ref.repo
	].join("/");
	assertAllowedUrl(url);
	let response;
	try {
		response = await fetch(url, { headers: {
			accept: "application/vnd.github+json",
			"user-agent": "dsh-deep-plugin-manager",
			...authHeader()
		} });
	} catch (error) {
		throw new GitHubError(`GitHub request failed: ${String(error)}`, String(error));
	}
	if (response.status === 404) return null;
	if (response.status === 403 || response.status === 429) throw new GitHubError("GitHub rate limit reached. Try again later, or set GITHUB_TOKEN to raise the limit.");
	if (!response.ok) throw new GitHubError(`GitHub responded ${String(response.status)} for ${ref.owner}/${ref.repo}.`);
	const body = await response.json().catch(() => null);
	if (body === null) throw new GitHubError("GitHub returned an unreadable repository payload.");
	return typeof body.description === "string" && body.description !== "" ? { description: body.description } : {};
}
/**
* Compare a release tag against an installed version. Both are stripped of a
* leading `v` and compared numerically per dot segment when they look like
* versions; mismatched shapes fall back to inequality.
* @param installedTagOrVersion - currently installed version or tag.
* @param latestTag - the latest release tag.
* @returns whether `latestTag` is newer.
*/
function isNewerVersion(installedTagOrVersion, latestTag) {
	const normalize = (value) => value.trim().replace(/^v/i, "");
	const installed = normalize(installedTagOrVersion);
	const latest = normalize(latestTag);
	if (installed === latest) return false;
	const installedParts = installed.split(".").map((part) => Number.parseInt(part, 10));
	const latestParts = latest.split(".").map((part) => Number.parseInt(part, 10));
	if (installedParts.every((part) => Number.isInteger(part)) && latestParts.every((part) => Number.isInteger(part))) {
		const length = Math.max(installedParts.length, latestParts.length);
		for (let index = 0; index < length; index += 1) {
			const left = installedParts[index] ?? 0;
			const right = latestParts[index] ?? 0;
			if (left !== right) return right > left;
		}
		return false;
	}
	return installed !== latest;
}

//#endregion
//#region src/profile.ts
/**
* The profile is the Harness's own plugin state: one `package.json` whose
* `dependencies` hold installed plugins and whose `dsh.profile.bundles` holds
* the enabled subset. Deep Plugin Manager keeps zero state of its own — every
* read and write here is the Harness's source of truth, written the same way
* the `dsh plugin` CLI and the desktop manager write it.
*
* @module dsh-deep-plugin-manager/profile
*/
/** Packages the Harness owns; the manager refuses to touch them. */
const RESERVED_PREFIXES = ["@deepseek-ai/"];
/** Whether a package name belongs to the Harness core or to this manager. */
function isReservedName(name) {
	return RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)) || name === "dsh-deep-plugin-manager";
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
function resolveProfileDir(moduleUrl, profilesRoot) {
	const selfName = nearestManifestName(fileURLToPath(moduleUrl));
	let dir = dirname(fileURLToPath(moduleUrl));
	for (let depth = 0; depth < 12; depth += 1) {
		const manifestPath = join(dir, "package.json");
		if (existsSync(manifestPath)) try {
			const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (parsed.dsh !== void 0 && typeof parsed.dsh === "object" && parsed.dsh.profile !== void 0 && typeof parsed.dsh.profile === "object") return dir;
		} catch {}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (selfName !== void 0 && profilesRoot !== void 0 && profilesRoot !== "") {
		if (existsSync(profilesRoot)) for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidate = join(profilesRoot, entry.name);
			if (existsSync(join(candidate, "node_modules", ...selfName.split("/"), "package.json"))) return candidate;
		}
	}
	throw new ManagerError("profile-not-found", "Deep Plugin Manager could not locate the Harness profile directory it runs from.", 500);
}
/**
* Read the `name` of the nearest ancestor package manifest (this plugin's
* own manifest), used to identify the installing profile during the home
* scan.
* @param startFile - a file path inside the package.
* @returns the package name, or undefined when no manifest is readable.
*/
function nearestManifestName(startFile) {
	let dir = dirname(startFile);
	for (let depth = 0; depth < 6; depth += 1) {
		const manifestPath = join(dir, "package.json");
		if (existsSync(manifestPath)) try {
			const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (typeof parsed.name === "string") return parsed.name;
		} catch {
			return;
		}
		const parent = dirname(dir);
		if (parent === dir) return void 0;
		dir = parent;
	}
}
/**
* Read and structurally validate the profile manifest.
* @param profileDir - the profile directory.
* @returns the parsed manifest.
* @throws {ManagerError} when the manifest is missing or not a JSON object.
*/
function readManifest(profileDir) {
	const path = join(profileDir, "package.json");
	if (!existsSync(path)) throw new ManagerError("profile-not-found", `No profile manifest at ${path}.`, 500);
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ManagerError("manifest-corrupt", "The profile manifest is not valid JSON.", 500, String(error));
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ManagerError("manifest-corrupt", "The profile manifest must be a JSON object.", 500);
	return parsed;
}
/**
* Write the profile manifest atomically (temp file + rename) so a crash mid
* write cannot leave a truncated manifest.
* @param profileDir - the profile directory.
* @param manifest - the full manifest to persist.
*/
function writeManifest(profileDir, manifest) {
	const path = join(profileDir, "package.json");
	const temp = `${path}.dpm-tmp`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(temp, `${JSON.stringify(manifest, void 0, 2)}\n`);
	renameSync(temp, path);
}
/**
* List the profile's installed plugins, derived entirely from the profile
* manifest plus each installed package's own manifest.
* @param profileDir - the profile directory.
* @returns plugin entries sorted by name; Harness-owned packages are excluded.
*/
function listPlugins(profileDir) {
	const manifest = readManifest(profileDir);
	const bundles = new Set(manifest.dsh?.profile?.bundles ?? []);
	const entries = [];
	for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
		if (isReservedName(name)) continue;
		const manifestPath = join(profileDir, "node_modules", ...name.split("/"), "package.json");
		if (!existsSync(manifestPath)) {
			entries.push({
				name,
				version: "",
				spec,
				enabled: bundles.has(name)
			});
			continue;
		}
		try {
			const installed = JSON.parse(readFileSync(manifestPath, "utf8"));
			entries.push({
				name,
				version: typeof installed.version === "string" ? installed.version : "",
				spec,
				enabled: bundles.has(name),
				description: typeof installed.description === "string" ? installed.description : void 0,
				author: typeof installed.author === "string" ? installed.author : void 0,
				repository: typeof installed.repository === "object" && installed.repository !== null && typeof installed.repository.url === "string" ? installed.repository.url : typeof installed.repository === "string" ? installed.repository : void 0
			});
		} catch {
			entries.push({
				name,
				version: "",
				spec,
				enabled: bundles.has(name)
			});
		}
	}
	return entries.sort((left, right) => left.name.localeCompare(right.name));
}
/**
* Read one installed plugin's own manifest.
* @param profileDir - the profile directory.
* @param name - package name.
* @returns `{ version, bundlePatch }` when the package is installed.
* @throws {NotInstalledError} when the package is not materialized.
*/
function readInstalledPackage(profileDir, name) {
	const manifestPath = join(profileDir, "node_modules", ...name.split("/"), "package.json");
	if (!existsSync(manifestPath)) throw new NotInstalledError(name);
	const installed = JSON.parse(readFileSync(manifestPath, "utf8"));
	return {
		version: typeof installed.version === "string" ? installed.version : "",
		bundlePatch: typeof installed.dsh?.bundle?.patch === "string" ? installed.dsh.bundle.patch : void 0
	};
}
/**
* Assert a name may be managed: not Harness-reserved, not the manager itself.
* @param name - package name.
* @throws {ReservedNameError} when the name is owned by the Harness or self.
*/
function assertManageableName(name) {
	if (isReservedName(name)) throw new ReservedNameError(name);
}

//#endregion
//#region src/runner.ts
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
/** Arguments must stay inside this charset: the Windows spawn path goes
through a shell, so anything outside can never be allowed to ride along. */
const SAFE_ARG = /^[A-Za-z0-9@/:._#-]+$/;
/** Combined-output cap; pnpm failure diagnostics live at the tail. */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Install/update wall-clock ceiling; kills the child instead of hanging the UI. */
const TIMEOUT_MS = 600 * 1e3;
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
function findBundledPnpm() {
	const roots = [process.env.LOCALAPPDATA === void 0 ? void 0 : join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources", "runtime", "pnpm", "bin", "pnpm.cjs"), process.env.LOCALAPPDATA === void 0 ? void 0 : join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources", "runtime", "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.cjs")].filter((candidate) => candidate !== void 0);
	for (const candidate of roots) if (existsSync(candidate)) return candidate;
	const programs = process.env.LOCALAPPDATA === void 0 ? void 0 : join(process.env.LOCALAPPDATA, "Programs");
	if (programs !== void 0 && existsSync(programs)) for (const entry of readdirSync(programs, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.includes("DeepSeek")) continue;
		const candidate = join(programs, entry.name, "resources", "runtime", "pnpm", "bin", "pnpm.cjs");
		if (existsSync(candidate)) return candidate;
	}
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
function resolvePnpm(configured) {
	const override = configured ?? process.env.DSH_PNPM_EXECUTABLE;
	if (override !== void 0 && override.length > 0) return override;
	return findBundledPnpm() ?? "pnpm";
}
/** A bundled pnpm is a `.cjs` entry, which `spawn` cannot execute directly. */
function needsNode(executable) {
	return executable.endsWith(".cjs") || executable.endsWith(".js");
}
/**
* Whether pnpm refused the profile because its store belongs to another major.
*
* pnpm links `node_modules` from `store/v<major>`, and a different major refuses
* the tree rather than reinstalling it, so this is a configuration mismatch
* rather than anything about the requested operation.
*/
function isStoreMismatch(output) {
	return output.includes("ERR_PNPM_UNEXPECTED_STORE");
}
/** The bundled pnpm path, named in the error so the remedy is concrete. */
function describeBundled() {
	const bundled = findBundledPnpm();
	return bundled === void 0 ? "" : ` (${bundled})`;
}
/**
* Create the pnpm runner. The executable is resolved by {@link resolvePnpm};
* tests pass one explicitly.
* @param executable - pnpm executable override.
* @returns the runner.
*/
function createPnpmRunner(executable) {
	const resolved = resolvePnpm(executable);
	return async (profileDir, args) => {
		for (const argument of args) if (!SAFE_ARG.test(argument)) throw new RunnerError(`Refusing pnpm argument outside the safe charset: ${JSON.stringify(argument)}`);
		return new Promise((resolve, reject) => {
			const child = needsNode(resolved) ? spawn(process.execPath, [resolved, ...args], {
				cwd: profileDir,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			}) : spawn(resolved, [...args], {
				cwd: profileDir,
				shell: process.platform === "win32",
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
			let output = "";
			let failure;
			let settled = false;
			const append = (chunk) => {
				output = `${output}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT_BYTES);
			};
			const timer = setTimeout(() => {
				failure = new RunnerError("pnpm did not finish within 10 minutes and was stopped.");
				child.kill("SIGKILL");
			}, TIMEOUT_MS);
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", append);
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", append);
			child.once("error", (error) => {
				failure = error instanceof Error ? new RunnerError(`pnpm could not be started: ${error.message}`, String(error)) : new RunnerError("pnpm could not be started.");
			});
			child.once("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (failure !== void 0) {
					reject(failure);
					return;
				}
				if (code !== 0 && isStoreMismatch(output)) {
					reject(new RunnerError(`This profile was installed with a different pnpm major version, so its packages are linked from a store this pnpm will not use. Run the operation again once \`pnpmCommand\` points at the pnpm the Harness itself uses${describeBundled()}.`, output));
					return;
				}
				resolve({
					code: code ?? 1,
					output
				});
			});
		});
	};
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
async function runPnpm(runner, profileDir, args, action) {
	const result = await runner(profileDir, args);
	if (result.code !== 0) {
		const output = result.output.trim();
		throw new RunnerError(`pnpm failed while trying to ${action}.${/allowBuilds|build scripts|prepare|ignored build/i.test(output) ? " pnpm likely blocked the package build scripts: add the key it printed under `allowBuilds` in the profile pnpm-workspace.yaml, then retry." : ""}`, output);
	}
	return result;
}

//#endregion
//#region src/lifecycle.ts
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
/**
* Whether an inserted module name mounts one package: equal to it, or a
* subpath of it (`pkg/client`). Compared in place; nothing is concatenated.
*/
function mountsPackage(mounted, name) {
	if (mounted === name) return true;
	return mounted.indexOf(name) === 0 && mounted.charAt(name.length) === "/";
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
function readPatchMountedNames(profileDir) {
	const patchPath = join(profileDir, "cordis.patch.yml");
	if (!existsSync(patchPath)) return [];
	const names = [];
	for (const line of readFileSync(patchPath, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("name: ") === false) continue;
		const value = trimmed.slice(6).trim();
		if (value !== "") names.push(value);
	}
	return names;
}
/**
* Whether one package is mounted through the profile's patch layer.
* @param profileDir - the profile directory.
* @param name - package name.
* @returns whether the patch layer mounts the package.
*/
function isPatchMounted(profileDir, name) {
	return readPatchMountedNames(profileDir).some((mounted) => mountsPackage(mounted, name));
}
/**
* Refuse enable/disable for a plugin the patch layer mounts: the bundle list
* does not control it, so the toggle would silently do nothing.
* @param profileDir - the profile directory.
* @param name - package name.
* @throws {ManagerError} with a pointer to the patch file when mounted.
*/
function assertNotPatchMounted(profileDir, name) {
	if (isPatchMounted(profileDir, name)) throw new ManagerError("patch-managed", `"${name}" is mounted through the profile's cordis.patch.yml — enable or disable it there.`, 409);
}
/**
* Create the lifecycle manager bound to one profile directory.
* @param options - profile directory, pnpm runner, optional GitHub overrides.
* @returns the manager operations.
*/
function createPluginManager(options) {
	const { profileDir, runner } = options;
	const releaseLookup = options.latestReleaseFn ?? latestRelease;
	const metadataLookup = options.repoMetadataFn ?? repoMetadata;
	const dependencyNames = (manifest) => Object.keys(manifest.dependencies ?? {});
	/** Remove one dependency through pnpm; failures surface as RunnerError. */
	const removePackage = async (name) => {
		await runPnpm(runner, profileDir, ["remove", name], `remove ${name}`);
	};
	const metaCachePath = join(profileDir, ".dsh-deep-plugin-manager.json");
	/** Read the metadata cache; unreadable or missing state is an empty cache. */
	const readMetaCache = () => {
		try {
			const parsed = JSON.parse(readFileSync(metaCachePath, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
		} catch {}
		return {};
	};
	/** Persist the metadata cache (plain write; it is disposable state). */
	const writeMetaCache = (cache) => {
		writeFileSync(metaCachePath, [JSON.stringify(cache, void 0, 2), ""].join("\n"));
	};
	/**
	* Remember one plugin's source repository and GitHub About text. Failures
	* are ignored: the cache is display enrichment, never lifecycle state.
	*/
	const rememberMetadata = async (name, repo) => {
		try {
			const meta = await metadataLookup(repo);
			const cache = readMetaCache();
			const previous = cache[name] ?? {};
			cache[name] = {
				repo: [repo.owner, repo.repo].join("/"),
				...meta?.description === void 0 ? previous : { description: meta.description }
			};
			writeMetaCache(cache);
		} catch {}
	};
	return {
		async list() {
			const entries = listPlugins(profileDir).map((entry) => ({
				...entry,
				patchMounted: isPatchMounted(profileDir, entry.name)
			}));
			const cache = readMetaCache();
			await Promise.allSettled(entries.map(async (entry) => {
				const repo = repoFromSpec(entry.spec);
				if (repo === void 0) return;
				entry.displayName = repo.repo;
				const cached = cache[entry.name];
				if (cached !== void 0) {
					if (cached.description !== void 0) entry.description = cached.description;
					return;
				}
				await rememberMetadata(entry.name, repo);
				const fresh = readMetaCache()[entry.name];
				if (fresh?.description !== void 0) entry.description = fresh.description;
			}));
			return entries;
		},
		async install(input) {
			const ref = parseRepoRef(input);
			const spec = specFor(ref);
			const before = readManifest(profileDir);
			const beforeNames = new Set(dependencyNames(before));
			await runPnpm(runner, profileDir, ["add", spec], `install ${spec}`);
			const after = readManifest(profileDir);
			const added = dependencyNames(after).filter((name$1) => !beforeNames.has(name$1));
			if (added.length === 0) {
				const existing = dependencyNames(after).find((name$1) => after.dependencies?.[name$1] === spec);
				if (existing !== void 0) throw new AlreadyInstalledError(existing);
				throw new ManagerError("install-empty", "The install produced no new package.", 500);
			}
			let name;
			try {
				if (added.length !== 1) throw new ManagerError("install-empty", `The install yielded ${String(added.length)} top-level packages; expected exactly one.`, 500);
				const candidate = added[0] ?? "";
				assertManageableName(candidate);
				if (readInstalledPackage(profileDir, candidate).bundlePatch === void 0) throw new NotAPluginError(`"${candidate}" is not a DeepSeek Harness plugin: its package.json declares no dsh.bundle.patch.`);
				name = candidate;
			} catch (error) {
				writeManifest(profileDir, before);
				for (const addedName of added) await removePackage(addedName).catch(() => void 0);
				throw error;
			}
			enableInManifest(profileDir, name);
			const installed = readInstalledPackage(profileDir, name);
			await rememberMetadata(name, ref);
			return {
				name,
				version: installed.version,
				spec: after.dependencies?.[name] ?? spec,
				restartRequired: true
			};
		},
		enable(name) {
			assertManageableName(name);
			const manifest = readManifest(profileDir);
			if (!Object.hasOwn(manifest.dependencies ?? {}, name)) throw new NotInstalledError(name);
			assertNotPatchMounted(profileDir, name);
			const bundles = manifest.dsh?.profile?.bundles ?? [];
			if (bundles.includes(name)) return;
			writeManifest(profileDir, {
				...manifest,
				dsh: {
					...manifest.dsh,
					profile: {
						...manifest.dsh?.profile,
						bundles: [...bundles, name]
					}
				}
			});
		},
		disable(name) {
			assertManageableName(name);
			const manifest = readManifest(profileDir);
			if (!Object.hasOwn(manifest.dependencies ?? {}, name)) throw new NotInstalledError(name);
			assertNotPatchMounted(profileDir, name);
			const bundles = manifest.dsh?.profile?.bundles ?? [];
			if (!bundles.includes(name)) return;
			writeManifest(profileDir, {
				...manifest,
				dsh: {
					...manifest.dsh,
					profile: {
						...manifest.dsh?.profile,
						bundles: bundles.filter((entry) => entry !== name)
					}
				}
			});
		},
		async uninstall(name) {
			assertManageableName(name);
			const manifest = readManifest(profileDir);
			if (!Object.hasOwn(manifest.dependencies ?? {}, name)) throw new NotInstalledError(name);
			const bundles = manifest.dsh?.profile?.bundles ?? [];
			const wasEnabled = bundles.includes(name);
			if (wasEnabled) writeManifest(profileDir, {
				...manifest,
				dsh: {
					...manifest.dsh,
					profile: {
						...manifest.dsh?.profile,
						bundles: bundles.filter((entry) => entry !== name)
					}
				}
			});
			try {
				await removePackage(name);
			} catch (error) {
				if (wasEnabled) {
					const current = readManifest(profileDir);
					writeManifest(profileDir, {
						...current,
						dsh: {
							...current.dsh,
							profile: {
								...current.dsh?.profile,
								bundles: [...current.dsh?.profile?.bundles ?? [], name]
							}
						}
					});
				}
				throw error;
			}
		},
		async checkUpdate(name) {
			const repo = repoFromSpec(specOf(name));
			if (repo === void 0) throw new InvalidRefError(`"${name}" was not installed from GitHub, so there is nothing to check.`);
			const current = readInstalledPackage(profileDir, name).version;
			const latest = await releaseLookup(repo);
			if (latest === null) return {
				name,
				current,
				latest: null,
				updateAvailable: false
			};
			return {
				name,
				current,
				latest,
				updateAvailable: isNewerVersion(current, latest.tag),
				...latest.url === void 0 ? {} : { releaseUrl: latest.url }
			};
		},
		async update(name) {
			assertManageableName(name);
			const spec = specOf(name);
			const repo = repoFromSpec(spec);
			if (repo === void 0) throw new InvalidRefError(`"${name}" was not installed from GitHub, so it cannot be updated here.`);
			const current = readInstalledPackage(profileDir, name).version;
			const latest = await releaseLookup(repo);
			let target;
			if (latest === null) {
				target = spec;
				await runPnpm(runner, profileDir, ["add", spec], `update ${name}`);
			} else if (!isNewerVersion(current, latest.tag)) return {
				name,
				version: current,
				restartRequired: true
			};
			else {
				target = repo.ref !== void 0 ? spec : specFor({
					...repo,
					ref: latest.tag
				});
				await runPnpm(runner, profileDir, ["add", target], `update ${name} to ${latest.tag}`);
			}
			await rememberMetadata(name, repo);
			return {
				name,
				version: readInstalledPackage(profileDir, name).version || target,
				restartRequired: true
			};
		}
	};
	/** Dependency spec of one installed plugin, from the profile manifest. */
	function specOf(name) {
		const spec = readManifest(profileDir).dependencies?.[name];
		if (spec === void 0) throw new NotInstalledError(name);
		return spec;
	}
	/** Add one plugin to the enabled bundle list when it is not listed yet. */
	function enableInManifest(dir, pluginName) {
		const manifest = readManifest(dir);
		const bundles = manifest.dsh?.profile?.bundles ?? [];
		if (bundles.includes(pluginName)) return;
		writeManifest(dir, {
			...manifest,
			dsh: {
				...manifest.dsh,
				profile: {
					...manifest.dsh?.profile,
					bundles: [...bundles, pluginName]
				}
			}
		});
	}
}

//#endregion
//#region src/routes.ts
/** The JSON body cap: install inputs are tiny; anything larger is refused. */
const MAX_BODY_BYTES = 64 * 1024;
/**
* Create the manager API from the lifecycle options.
* @param options - profile directory, runner, optional GitHub override.
* @returns the API object the routes dispatch to.
*/
function createApi(options) {
	return createPluginManager(options);
}
/**
* Dispatch one request to the API. The prefix route hands every path here;
* matching is by method + exact suffix.
* @param req - incoming request.
* @param res - server response.
* @param api - the manager API.
*/
async function handleRequest(req, res, api) {
	const path = (req.url ?? "").split("?")[0] ?? "";
	const method = req.method ?? "GET";
	try {
		if (path === "/deep-plugin-manager/plugins" && method === "GET") {
			sendJson(res, 200, { plugins: await api.list() });
			return;
		}
		if (path === "/deep-plugin-manager/install" && method === "POST") {
			const input = readStringField(await readJsonBody(req), "input");
			sendJson(res, 200, { result: await api.install(input) });
			return;
		}
		if (path === "/deep-plugin-manager/enable" && method === "POST") {
			const body = await readJsonBody(req);
			api.enable(readStringField(body, "name"));
			sendJson(res, 200, {
				ok: true,
				restartRequired: true
			});
			return;
		}
		if (path === "/deep-plugin-manager/disable" && method === "POST") {
			const body = await readJsonBody(req);
			api.disable(readStringField(body, "name"));
			sendJson(res, 200, {
				ok: true,
				restartRequired: true
			});
			return;
		}
		if (path === "/deep-plugin-manager/uninstall" && method === "POST") {
			const body = await readJsonBody(req);
			await api.uninstall(readStringField(body, "name"));
			sendJson(res, 200, { ok: true });
			return;
		}
		if (path === "/deep-plugin-manager/update" && method === "POST") {
			const body = await readJsonBody(req);
			sendJson(res, 200, { result: await api.update(readStringField(body, "name")) });
			return;
		}
		if (path === "/deep-plugin-manager/check-update" && method === "GET") {
			const name = new URL(req.url ?? "/", "http://localhost").searchParams.get("name") ?? "";
			if (name === "") throw new ManagerError("bad-request", "Missing plugin name.", 400);
			sendJson(res, 200, await api.checkUpdate(name));
			return;
		}
		sendJson(res, 404, { error: {
			kind: "not-found",
			message: `No management route for ${method} ${path}.`
		} });
	} catch (error) {
		if (error instanceof ManagerError) {
			sendJson(res, error.status, { error: {
				kind: error.kind,
				message: error.message,
				...error.detail === void 0 ? {} : { detail: error.detail }
			} });
			return;
		}
		sendJson(res, 500, { error: {
			kind: "internal",
			message: error instanceof Error ? error.message : String(error)
		} });
	}
}
/** One pending JSON body as a parsed object. */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new ManagerError("bad-request", "Request body too large.", 413);
		chunks.push(chunk);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.trim() === "") throw new ManagerError("bad-request", "A JSON body is required.", 400);
	const parsed = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ManagerError("bad-request", "The request body must be a JSON object.", 400);
	return parsed;
}
/** One required string field from a parsed JSON body. */
function readStringField(body, field) {
	const value = body[field];
	if (typeof value !== "string" || value.trim() === "") throw new ManagerError("bad-request", `The "${field}" field is required.`, 400);
	return value.trim();
}
/** Serialize one JSON response and finish it. */
function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(body);
}

//#endregion
//#region src/index.ts
/** Required services: the Harness home (profile lookup) and the web server. */
const inject = ["dshHomePath", "webServer"];
/** The route prefix every management endpoint lives under. */
const ROUTE_PREFIX = "/deep-plugin-manager";
/**
* Mount the plugin manager.
* @param ctx - host context (home path and web server are injected).
* @param config - the pnpm executable to run package operations with.
*/
function apply(ctx, config) {
	ctx.inject(["dshHomePath", "webServer"], (scope) => {
		const api = createApi({
			profileDir: resolveProfileDir(import.meta.url, scope.dshHomePath("profiles")),
			runner: createPnpmRunner(config?.pnpmCommand)
		});
		scope.effect(() => scope.webServer.register({
			kind: "prefix",
			path: ROUTE_PREFIX,
			handler: (req, res) => {
				handleRequest(req, res, api);
			}
		}), "deep-plugin-manager: management routes");
	});
}

//#endregion
export { ROUTE_PREFIX, apply, inject };