window.__ModuleLoader__.load({ id: "dsh-deep-plugin-manager", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");

//#region src/client/api.ts
/** Read the manager's own install state. */
function fetchSelf() {
	return call("/deep-plugin-manager/self");
}
/** Update the manager itself from its GitHub repository. */
function updateSelf() {
	return call("/deep-plugin-manager/self-update", { method: "POST" });
}
/** One failed management call, with the tool output when present. */
var ApiError = class extends Error {
	kind;
	detail;
	/**
	* @param kind - machine-readable failure kind from the route layer.
	* @param message - presentable failure message.
	* @param detail - captured tool output, when present.
	*/
	constructor(kind, message, detail) {
		super(message);
		this.name = "ApiError";
		this.kind = kind;
		this.detail = detail;
	}
};
/** One JSON request to the management API. */
async function call(path, init) {
	const response = await fetch(path, {
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		...init
	});
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const error = body?.error;
		throw new ApiError(typeof error?.kind === "string" ? error.kind : "unknown", typeof error?.message === "string" ? error.message : `Request failed (${String(response.status)}).`, typeof error?.detail === "string" ? error.detail : void 0);
	}
	return body;
}
/** List the profile's installed plugins. */
function listPlugins() {
	return call("/deep-plugin-manager/plugins");
}
/** Install one GitHub-hosted plugin. */
function installPlugin(input) {
	return call("/deep-plugin-manager/install", {
		method: "POST",
		body: JSON.stringify({ input })
	});
}
/** Enable one installed plugin. */
function enablePlugin(name) {
	return call("/deep-plugin-manager/enable", {
		method: "POST",
		body: JSON.stringify({ name })
	});
}
/** Disable one installed plugin (stays installed). */
function disablePlugin(name) {
	return call("/deep-plugin-manager/disable", {
		method: "POST",
		body: JSON.stringify({ name })
	});
}
/** Uninstall one plugin. */
function uninstallPlugin(name) {
	return call("/deep-plugin-manager/uninstall", {
		method: "POST",
		body: JSON.stringify({ name })
	});
}
/** Check one plugin's GitHub repository for a newer release. */
function checkUpdate(name) {
	return call(`/deep-plugin-manager/check-update?name=${encodeURIComponent(name)}`);
}
/** Update one plugin from its GitHub repository. */
function updatePlugin(name) {
	return call("/deep-plugin-manager/update", {
		method: "POST",
		body: JSON.stringify({ name })
	});
}

//#endregion
//#region src/client/PluginManagerSection.tsx
/**
* The Deep Plugin Manager settings page: installed-plugin list with
* enable/disable, update (with release check), uninstall, and a GitHub
* install box — all driven through the same-origin management API, styled
* entirely with Harness tokens.
*
* @module dsh-deep-plugin-manager/client/PluginManagerSection
*/
/**
* Whether the Update button should be offered.
*
* A check that came back up to date must leave no button: clicking Update then
* would run pnpm for a package already at the latest version. Exported so the
* rule is asserted directly in tests/update-ui.spec.ts.
* @param update - the row's stored check result, if any.
* @returns whether Update should be shown.
*/
function updateAvailable(update) {
	return update !== void 0 && update !== "error" && update.updateAvailable;
}
/**
* The Plugin Manager page.
* @param props - localized copy seat.
* @returns the settings section.
*/
function PluginManagerSection({ t }) {
	const [plugins, setPlugins] = (0, react.useState)(void 0);
	const [self, setSelf] = (0, react.useState)(void 0);
	const [selfCheck, setSelfCheck] = (0, react.useState)(void 0);
	const [busy, setBusy] = (0, react.useState)(null);
	const [banner, setBanner] = (0, react.useState)(null);
	const [input, setInput] = (0, react.useState)("");
	const [confirming, setConfirming] = (0, react.useState)(null);
	const [updates, setUpdates] = (0, react.useState)({});
	const [showDetail, setShowDetail] = (0, react.useState)(false);
	const refresh = (0, react.useCallback)(async () => {
		const { plugins: entries } = await listPlugins();
		setPlugins(entries);
		const { self: info } = await fetchSelf();
		setSelf(info);
	}, []);
	(0, react.useEffect)(() => {
		refresh().catch((error) => {
			setBanner(errorBanner(t, error));
			setPlugins([]);
			setSelf(void 0);
		});
	}, [refresh, t]);
	/** Run one management action with busy + banner handling, then refresh. */
	const run = (0, react.useCallback)(async (key, action) => {
		setBusy(key);
		setBanner({
			kind: "info",
			text: t("status.working")
		});
		try {
			const message = await action();
			await refresh();
			if (message !== null) setBanner({
				kind: "ok",
				text: message
			});
			else setBanner(null);
		} catch (error) {
			setBanner(errorBanner(t, error));
		} finally {
			setBusy(null);
		}
	}, [refresh, t]);
	const doInstall = (0, react.useCallback)(async () => {
		if (input.trim() === "") {
			setBanner({
				kind: "error",
				text: t("install.invalid")
			});
			return;
		}
		const value = input.trim();
		await run("install", async () => {
			const { result } = await installPlugin(value);
			setInput("");
			return t("install.done", { name: result.name });
		});
	}, [
		input,
		run,
		t
	]);
	const doSetEnabled = (0, react.useCallback)(async (name, enabled) => {
		await run(`enable:${name}`, async () => {
			await (enabled ? enablePlugin(name) : disablePlugin(name));
			return null;
		});
	}, [run]);
	const doUninstall = (0, react.useCallback)(async (name) => {
		if (confirming !== name) {
			setConfirming(name);
			return;
		}
		setConfirming(null);
		await run(`uninstall:${name}`, async () => {
			await uninstallPlugin(name);
			return t("list.empty");
		});
		setBanner(null);
	}, [
		confirming,
		run,
		t
	]);
	/** Run one check and store its verdict; a failure stores 'error'. */
	const doCheck = (0, react.useCallback)(async (name) => {
		setBusy(`check:${name}`);
		try {
			const check = await checkUpdate(name);
			setUpdates((previous) => ({
				...previous,
				[name]: check
			}));
		} catch (error) {
			setUpdates((previous) => ({
				...previous,
				[name]: "error"
			}));
			setBanner(errorBanner(t, error));
		} finally {
			setBusy(null);
		}
	}, [t]);
	/**
	* Update one plugin, then clear its check result.
	*
	* The stored verdict describes the version that was checked, so keeping it
	* after an update would leave the row claiming an update is still available
	* for the version just replaced. Clearing returns the row to 'not checked',
	* and the user checks again to see where they now stand.
	*/
	const doUpdate = (0, react.useCallback)(async (name) => {
		await run(`update:${name}`, async () => {
			const { result } = await updatePlugin(name);
			setUpdates((previous) => {
				const next = { ...previous };
				delete next[name];
				return next;
			});
			return t("update.done", {
				name,
				version: result.version
			});
		});
	}, [run, t]);
	const doSelfCheck = (0, react.useCallback)(async () => {
		setBusy("self-check");
		try {
			setSelfCheck(await checkUpdate(self?.name ?? ""));
		} catch (error) {
			setSelfCheck("error");
			setBanner(errorBanner(t, error));
		} finally {
			setBusy(null);
		}
	}, [self, t]);
	const doSelfUpdate = (0, react.useCallback)(async () => {
		await run("self-update", async () => {
			const { result } = await updateSelf();
			setSelfCheck(void 0);
			return t("update.done", {
				name: result.name,
				version: result.version
			});
		});
	}, [run, t]);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dpm-section",
		"data-deep-plugin-manager": true,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				className: "dpm-heading",
				children: t("title")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dpm-intro",
				children: t("intro")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dpm-note",
				children: t("restart.note")
			}),
			self !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SelfCard, {
				self,
				check: selfCheck,
				busy,
				t,
				onCheck: () => {
					doSelfCheck();
				},
				onUpdate: () => {
					doSelfUpdate();
				}
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dpm-install",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: "text",
					value: input,
					placeholder: t("install.placeholder"),
					onChange: (event) => {
						setInput(event.target.value);
					},
					onKeyDown: (event) => {
						if (event.key === "Enter") doInstall();
					},
					disabled: busy !== null,
					"aria-label": t("install.placeholder")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dpm-button",
					onClick: () => {
						doInstall();
					},
					disabled: busy !== null || input.trim() === "",
					children: busy === "install" ? t("install.working") : t("install.button")
				})]
			}),
			banner !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `dpm-banner ${banner.kind}`,
				role: "status",
				children: [banner.text, banner.detail !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dpm-detail-toggle",
					onClick: () => {
						setShowDetail((visible) => !visible);
					},
					children: t("error.detail")
				}), showDetail && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
					className: "dpm-detail",
					children: banner.detail
				})] })]
			}),
			plugins === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dpm-empty",
				children: t("status.working")
			}) : plugins.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dpm-empty",
				children: t("list.empty")
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dpm-list",
				children: plugins.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PluginRow, {
					entry,
					busy,
					confirming: confirming === entry.name,
					update: updates[entry.name],
					t,
					onToggle: () => {
						doSetEnabled(entry.name, !entry.enabled);
					},
					onUninstall: () => {
						doUninstall(entry.name);
					},
					onCheck: () => {
						doCheck(entry.name);
					},
					onUpdate: () => {
						doUpdate(entry.name);
					}
				}, entry.name))
			})
		]
	});
}
/**
* The manager's own update card.
*
* The spec the profile records is the source the check runs from, so nothing
* has to be typed: the button asks GitHub about the repository the manager was
* already installed from. Update is offered only after a check has actually
* found something, and disappears again once the update lands.
*/
function SelfCard({ self, check, busy, t, onCheck, onUpdate }) {
	const done = check !== void 0 && check !== "error" ? check : null;
	const verdict = done === null ? null : checkStatusText(done, t);
	const canUpdate = updateAvailable(check);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dpm-self",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "dpm-main",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dpm-name",
						children: t("self.title")
					}),
					self.version !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dpm-version",
						children: self.version
					}),
					canUpdate && done !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dpm-badge",
						children: done.basis === "commit" ? t("update.commitAvailable") : t("update.available", { tag: done.latest?.tag ?? "" })
					})
				] }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dpm-desc",
					children: t("self.intro")
				}),
				verdict !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dpm-verdict",
					children: verdict
				}),
				!self.updatable && self.reason !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dpm-verdict muted",
					children: self.reason
				})
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "dpm-actions",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dpm-button quiet",
				onClick: onCheck,
				disabled: busy !== null,
				children: busy === "self-check" ? t("action.checking") : check === void 0 ? t("action.check") : t("self.recheck")
			}), canUpdate && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dpm-button",
				onClick: onUpdate,
				disabled: busy !== null,
				children: busy === "self-update" ? t("action.working") : t("action.update")
			})]
		})]
	});
}
/** One line describing what a completed check found. */
function checkStatusText(check, t) {
	if (!check.comparable) return t("update.commitUnknown");
	if (check.basis === "commit") {
		if (check.head === void 0) return t("update.headUnknown");
		return check.updateAvailable ? t("update.commitAvailable") : t("update.commitUptodate");
	}
	if (check.latest === null) return t("update.headUnknown");
	return check.updateAvailable ? t("update.available", { tag: check.latest.tag }) : t("update.uptodate");
}
/** One installed-plugin row: identity, state toggle, and lifecycle actions. */
function PluginRow({ entry, busy, confirming, update, t, onToggle, onUninstall, onCheck, onUpdate }) {
	const rowBusy = (key) => busy === key;
	const done = update !== void 0 && update !== "error" ? update : null;
	const canUpdate = updateAvailable(update);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dpm-row",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dpm-main",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dpm-name",
							children: entry.displayName ?? entry.name
						}),
						entry.version !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dpm-version",
							children: entry.version
						}),
						canUpdate && done !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dpm-badge",
							children: done.basis === "commit" ? t("update.commitAvailable") : t("update.available", { tag: done.latest?.tag ?? "" })
						})
					] }),
					done !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dpm-verdict",
						children: checkStatusText(done, t)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dpm-spec",
						title: entry.spec,
						children: [t("managed.by", { spec: entry.spec }), entry.displayName !== void 0 && entry.displayName !== entry.name && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dpm-pkg",
							children: [" · ", entry.name]
						})]
					}),
					entry.description !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dpm-desc",
						children: entry.description
					})
				]
			}),
			entry.patchMounted ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dpm-state",
				title: t("restart.note"),
				children: t("enabled.patch")
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				role: "switch",
				"aria-checked": entry.enabled,
				className: "dpm-switch",
				onClick: onToggle,
				disabled: busy !== null,
				"aria-label": `${entry.name} — ${entry.enabled ? t("enabled.on") : t("enabled.off")}`
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dpm-actions",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dpm-button quiet",
						onClick: onCheck,
						disabled: busy !== null,
						children: rowBusy(`check:${entry.name}`) ? t("action.checking") : t("action.check")
					}),
					canUpdate && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dpm-button quiet",
						onClick: onUpdate,
						disabled: busy !== null,
						children: rowBusy(`update:${entry.name}`) ? t("action.working") : t("action.update")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dpm-button danger",
						onClick: onUninstall,
						disabled: busy !== null,
						children: confirming || rowBusy(`uninstall:${entry.name}`) ? t("action.confirmUninstall") : t("action.uninstall")
					})
				]
			})
		]
	});
}
/** Map one thrown failure to a banner. */
function errorBanner(t, error) {
	if (error instanceof ApiError) return {
		kind: "error",
		text: t("error.generic", { message: error.message }),
		...error.detail === void 0 ? {} : { detail: error.detail }
	};
	return {
		kind: "error",
		text: t("error.generic", { message: error instanceof Error ? error.message : String(error) })
	};
}

//#endregion
//#region src/client/locales.ts
/** `deepPluginManager` namespace dictionaries: the settings page copy. */
/** Dictionary namespace owned by this plugin. */
const NS = "deepPluginManager";
/** Simplified Chinese dictionary (the key-set source of truth). */
const zh = {
	nav: "插件管理",
	title: "Deep Plugin Manager",
	intro: "安装、启用、停用、更新和卸载来自 GitHub 的 DeepSeek Harness 插件。",
	"list.empty": "此配置文件尚未安装第三方插件。",
	"install.placeholder": "owner/repository 或 GitHub URL",
	"install.button": "安装",
	"install.working": "正在安装…",
	"install.done": "已安装 {name}。重启 Harness 后加载。",
	"install.invalid": "请输入 owner/repository 形式的 GitHub 仓库。",
	"enabled.on": "已启用",
	"enabled.off": "已停用",
	"enabled.patch": "补丁挂载",
	"action.enable": "启用",
	"action.disable": "停用",
	"action.update": "更新",
	"action.check": "检查更新",
	"action.checking": "检查中…",
	"action.uninstall": "卸载",
	"action.confirmUninstall": "确认卸载？",
	"action.working": "处理中…",
	"update.available": "有新版本 {tag}",
	"update.uptodate": "已是最新",
	"update.none": "该仓库未发布 release；更新将刷新到默认分支最新提交。",
	"update.done": "已更新 {name} 到 {version}。重启 Harness 后生效。",
	"update.commitAvailable": "有可用更新",
	"update.commitUptodate": "已是仓库最新版本。",
	"update.commitUnknown": "无法读取已安装的提交；更新可刷新到分支最新提交。",
	"update.headUnknown": "无法读取分支最新提交。",
	"self.title": "插件管理器",
	"self.intro": "检查并安装管理器自身的更新。",
	"self.checked": "已检查",
	"self.recheck": "重新检查",
	"restart.note": "启用/停用和安装的更改在重启 Harness 后生效。",
	"status.working": "正在处理，请稍候…",
	"error.generic": "操作失败：{message}",
	"error.detail": "查看详细信息",
	"managed.by": "来源：{spec}",
	"columns.plugin": "插件",
	"columns.status": "状态",
	"columns.actions": "操作"
};
/** English dictionary, key-identical to the Chinese source of truth. */
const en = {
	nav: "Plugin Manager",
	title: "Deep Plugin Manager",
	intro: "Install, enable, disable, update, and uninstall DeepSeek Harness plugins from GitHub.",
	"list.empty": "No third-party plugins are installed in this profile yet.",
	"install.placeholder": "owner/repository or a GitHub URL",
	"install.button": "Install",
	"install.working": "Installing…",
	"install.done": "Installed {name}. Restart the Harness to load it.",
	"install.invalid": "Enter a GitHub repository as owner/repository.",
	"enabled.on": "Enabled",
	"enabled.off": "Disabled",
	"enabled.patch": "Patch-mounted",
	"action.enable": "Enable",
	"action.disable": "Disable",
	"action.update": "Update",
	"action.check": "Check for updates",
	"action.checking": "Checking…",
	"action.uninstall": "Uninstall",
	"action.confirmUninstall": "Confirm uninstall?",
	"action.working": "Working…",
	"update.available": "Update available: {tag}",
	"update.uptodate": "Up to date",
	"update.none": "This repository publishes no releases; updating refreshes to the latest default-branch commit.",
	"update.done": "Updated {name} to {version}. Restart the Harness to apply.",
	"update.commitAvailable": "Update available",
	"update.commitUptodate": "Up to date with the repository.",
	"update.commitUnknown": "The installed commit could not be read; updating refreshes to the branch head.",
	"update.headUnknown": "The branch head could not be read.",
	"self.title": "Plugin Manager",
	"self.intro": "Check for and install updates to the manager itself.",
	"self.checked": "Checked",
	"self.recheck": "Check again",
	"restart.note": "Enable, disable, and install changes take effect when the Harness restarts.",
	"status.working": "Working, please wait…",
	"error.generic": "The operation failed: {message}",
	"error.detail": "View details",
	"managed.by": "Source: {spec}",
	"columns.plugin": "Plugin",
	"columns.status": "Status",
	"columns.actions": "Actions"
};

//#endregion
//#region src/client/styles.ts
/**
* The settings section stylesheet, injected for the plugin lifetime. Colors
* ride the Harness `--dsw-*` tokens so the page re-themes with whatever
* theme is active; one class family (`dpm-*`) keeps it collision-free.
*
* @module dsh-deep-plugin-manager/client/styles
*/
const SECTION_STYLES = `
.dpm-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}
.dpm-heading {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dpm-intro {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dpm-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dpm-install {
  display: flex;
  gap: 8px;
}
.dpm-install input {
  flex: 1;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-specific-input-major);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}
.dpm-install input:focus-visible {
  outline: 2px solid var(--dsw-alias-button-ghost-active-border);
  outline-offset: 1px;
}
.dpm-install input::placeholder { color: var(--dsw-alias-label-caption); }
.dpm-button {
  height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.dpm-button:hover { background: var(--dsw-alias-button-primary-hover); }
.dpm-button:focus-visible {
  outline: 2px solid var(--dsw-alias-button-ghost-active-border);
  outline-offset: 1px;
}
.dpm-button:disabled {
  opacity: 0.6;
  cursor: default;
}
.dpm-button.quiet {
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2);
}
.dpm-button.quiet:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dpm-button.danger {
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
  border: 1px solid var(--dsw-alias-border-l2);
}
.dpm-button.danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dpm-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dpm-self {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 12px;
  padding: 12px 14px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
}
.dpm-verdict {
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-state-success-primary);
  margin-top: 2px;
}
.dpm-verdict.muted {
  color: var(--dsw-alias-label-tertiary);
}
.dpm-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 12px;
  padding: 12px 14px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
}
.dpm-main {
  flex: 1 1 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dpm-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dpm-version {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin-left: 6px;
}
.dpm-pkg {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  margin-left: 6px;
}
.dpm-spec {
  font-size: 12px;
  color: var(--dsw-alias-label-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dpm-desc {
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dpm-state {
  flex: none;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  background: transparent;
}
.dpm-switch {
  flex: none;
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  cursor: pointer;
  padding: 0;
  transition: background var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.dpm-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: var(--dsw-alias-label-secondary);
  transition: transform var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    background var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.dpm-switch[aria-checked='true'] {
  background: var(--dsw-alias-state-success-primary);
  border-color: transparent;
}
.dpm-switch[aria-checked='true']::after {
  transform: translateX(16px);
  background: var(--dsw-alias-label-primary-foreground);
}
.dpm-switch:focus-visible {
  outline: 2px solid var(--dsw-alias-button-ghost-active-border);
  outline-offset: 1px;
}
.dpm-switch:disabled {
  opacity: 0.6;
  cursor: default;
}
.dpm-state.on {
  color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary);
}
.dpm-state:focus-visible {
  outline: 2px solid var(--dsw-alias-button-ghost-active-border);
  outline-offset: 1px;
}
.dpm-actions {
  flex: none;
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.dpm-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}
.dpm-banner {
  font-size: 13px;
  line-height: 19px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
}
.dpm-banner.ok {
  color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-state-success-tertiary);
}
.dpm-banner.error {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-secondary);
  overflow-wrap: anywhere;
}
.dpm-banner.info {
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.dpm-detail {
  margin: 6px 0 0;
  font-size: 11px;
  font-family: var(--ds-font-family-code, monospace);
  white-space: pre-wrap;
  word-break: break-word;
  color: inherit;
  opacity: 0.75;
}
.dpm-empty {
  margin: 0;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
}
.dpm-detail-toggle {
  border: 0;
  background: none;
  padding: 0;
  margin-left: 8px;
  font: inherit;
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
  color: inherit;
}
`;

//#endregion
//#region src/client/index.ts
/** The settings nav identity for this page. */
const SECTION_ID = "deep-plugin-manager";
/** Required services: slots and locale. */
const inject = ["slots", "locale"];
/**
* Client plugin body: dictionaries, stylesheet, and the settings page.
* @param ctx - client cordis context.
*/
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "deep-plugin-manager: dictionaries");
	ctx.effect(() => {
		const tag = document.createElement("style");
		tag.dataset.plugin = "dsh-deep-plugin-manager";
		tag.dataset.pluginCss = "dsh-deep-plugin-manager/section.css";
		tag.textContent = SECTION_STYLES;
		document.head.appendChild(tag);
		return () => {
			tag.remove();
		};
	}, "deep-plugin-manager: section stylesheet");
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: SECTION_ID,
		order: 30,
		label: () => ctx.locale.bind(NS)("nav"),
		locale: NS
	}, PluginManagerSection));
}

//#endregion
exports.SECTION_ID = SECTION_ID;
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=index.js.map