/** `deepPluginManager` namespace dictionaries: the settings page copy. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'deepPluginManager'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  nav: '插件管理',
  title: 'Deep Plugin Manager',
  intro: '安装、启用、停用、更新和卸载来自 GitHub 的 DeepSeek Harness 插件。',
  'list.empty': '此配置文件尚未安装第三方插件。',
  'install.placeholder': 'owner/repository 或 GitHub URL',
  'install.button': '安装',
  'install.working': '正在安装…',
  'install.done': '已安装 {name}。重启 Harness 后加载。',
  'install.invalid': '请输入 owner/repository 形式的 GitHub 仓库。',
  'enabled.on': '已启用',
  'enabled.off': '已停用',
  'enabled.patch': '补丁挂载',
  'action.enable': '启用',
  'action.disable': '停用',
  'action.update': '更新',
  'action.check': '检查更新',
  'action.checking': '检查中…',
  'action.uninstall': '卸载',
  'action.confirmUninstall': '确认卸载？',
  'action.working': '处理中…',
  'update.available': '有新版本 {tag}',
  'update.uptodate': '已是最新',
  'update.none': '该仓库未发布 release；更新将刷新到默认分支最新提交。',
  'update.done': '已更新 {name} 到 {version}。重启 Harness 后生效。',
  'restart.note': '启用/停用和安装的更改在重启 Harness 后生效。',
  'status.working': '正在处理，请稍候…',
  'error.generic': '操作失败：{message}',
  'error.detail': '查看详细信息',
  'managed.by': '来源：{spec}',
  'columns.plugin': '插件',
  'columns.status': '状态',
  'columns.actions': '操作',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<DeepPluginManagerKey, string> = {
  nav: 'Plugin Manager',
  title: 'Deep Plugin Manager',
  intro: 'Install, enable, disable, update, and uninstall DeepSeek Harness plugins from GitHub.',
  'list.empty': 'No third-party plugins are installed in this profile yet.',
  'install.placeholder': 'owner/repository or a GitHub URL',
  'install.button': 'Install',
  'install.working': 'Installing…',
  'install.done': 'Installed {name}. Restart the Harness to load it.',
  'install.invalid': 'Enter a GitHub repository as owner/repository.',
  'enabled.on': 'Enabled',
  'enabled.off': 'Disabled',
  'enabled.patch': 'Patch-mounted',
  'action.enable': 'Enable',
  'action.disable': 'Disable',
  'action.update': 'Update',
  'action.check': 'Check for updates',
  'action.checking': 'Checking…',
  'action.uninstall': 'Uninstall',
  'action.confirmUninstall': 'Confirm uninstall?',
  'action.working': 'Working…',
  'update.available': 'Update available: {tag}',
  'update.uptodate': 'Up to date',
  'update.none': 'This repository publishes no releases; updating refreshes to the latest default-branch commit.',
  'update.done': 'Updated {name} to {version}. Restart the Harness to apply.',
  'restart.note': 'Enable, disable, and install changes take effect when the Harness restarts.',
  'status.working': 'Working, please wait…',
  'error.generic': 'The operation failed: {message}',
  'error.detail': 'View details',
  'managed.by': 'Source: {spec}',
  'columns.plugin': 'Plugin',
  'columns.status': 'Status',
  'columns.actions': 'Actions',
}

/** Key domain of the `deepPluginManager` namespace (zh is the source of truth). */
export type DeepPluginManagerKey = keyof typeof zh
