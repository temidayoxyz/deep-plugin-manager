/**
 * The Deep Plugin Manager settings page: installed-plugin list with
 * enable/disable, update (with release check), uninstall, and a GitHub
 * install box — all driven through the same-origin management API, styled
 * entirely with Harness tokens.
 *
 * @module dsh-deep-plugin-manager/client/PluginManagerSection
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ApiError, checkUpdate, disablePlugin, enablePlugin, fetchSelf, installPlugin, listPlugins,
  uninstallPlugin, updatePlugin, updateSelf,
  type PluginEntry, type SelfInfo, type UpdateCheck,
} from './api.ts'
import type { LocaleSeat } from './harness-types.ts'

/** Which operation is running; at most one at a time. */
export type Busy = 'install' | 'self-update' | 'self-check'
  | `enable:${string}` | `disable:${string}` | `uninstall:${string}`
  | `update:${string}` | `check:${string}`

/** One banner message shown above the list. */
export interface Banner {
  kind: 'ok' | 'error' | 'info'
  text: string
  detail?: string
}

/**
 * Update-check outcome per plugin name (undefined until checked).
 *
 * A completed check is stored as the verdict itself, so the UI can tell
 * 'checked and up to date' from 'not checked yet' — which is what decides
 * whether the Update button is offered at all.
 */
export type UpdateState = Record<string, UpdateCheck | 'error'>

/** One row's or the manager's own check state. */
export type RowState = UpdateCheck | 'error' | undefined

/**
 * Whether the Update button should be offered.
 *
 * A check that came back up to date must leave no button: clicking Update then
 * would run pnpm for a package already at the latest version. Exported so the
 * rule is asserted directly in tests/update-ui.spec.ts.
 * @param update - the row's stored check result, if any.
 * @returns whether Update should be shown.
 */
export function updateAvailable(update: RowState): boolean {
  return update !== undefined && update !== 'error' && update.updateAvailable
}

/** Full component props: the locale seat. */
export interface PluginManagerSectionProps {
  t: LocaleSeat['t']
}

/**
 * The Plugin Manager page.
 * @param props - localized copy seat.
 * @returns the settings section.
 */
export function PluginManagerSection({ t }: PluginManagerSectionProps) {
  const [plugins, setPlugins] = useState<PluginEntry[] | undefined>(undefined)
  const [self, setSelf] = useState<SelfInfo | undefined>(undefined)
  const [selfCheck, setSelfCheck] = useState<UpdateCheck | 'error' | undefined>(undefined)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [input, setInput] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [updates, setUpdates] = useState<UpdateState>({})
  const [showDetail, setShowDetail] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const { plugins: entries } = await listPlugins()
    setPlugins(entries)
    const { self: info } = await fetchSelf()
    setSelf(info)
  }, [])

  useEffect(() => {
    refresh().catch((error: unknown) => {
      setBanner(errorBanner(t, error))
      setPlugins([])
      setSelf(undefined)
    })
  }, [refresh, t])

  /** Run one management action with busy + banner handling, then refresh. */
  const run = useCallback(async (key: Busy, action: () => Promise<string | null>): Promise<void> => {
    setBusy(key)
    setBanner({ kind: 'info', text: t('status.working') })
    try {
      const message = await action()
      await refresh()
      if (message !== null) setBanner({ kind: 'ok', text: message })
      else setBanner(null)
    } catch (error) {
      setBanner(errorBanner(t, error))
    } finally {
      setBusy(null)
    }
  }, [refresh, t])

  const doInstall = useCallback(async () => {
    if (input.trim() === '') {
      setBanner({ kind: 'error', text: t('install.invalid') })
      return
    }
    const value = input.trim()
    await run('install', async () => {
      const { result } = await installPlugin(value)
      setInput('')
      return t('install.done', { name: result.name })
    })
  }, [input, run, t])

  const doSetEnabled = useCallback(async (name: string, enabled: boolean) => {
    await run(`enable:${name}` as Busy, async () => {
      await (enabled ? enablePlugin(name) : disablePlugin(name))
      return null
    })
  }, [run])

  const doUninstall = useCallback(async (name: string) => {
    if (confirming !== name) {
      setConfirming(name)
      return
    }
    setConfirming(null)
    await run(`uninstall:${name}` as Busy, async () => {
      await uninstallPlugin(name)
      return t('list.empty')
    })
    setBanner(null)
  }, [confirming, run, t])

  /** Run one check and store its verdict; a failure stores 'error'. */
  const doCheck = useCallback(async (name: string) => {
    setBusy(`check:${name}`)
    try {
      const check: UpdateCheck = await checkUpdate(name)
      setUpdates((previous) => ({ ...previous, [name]: check }))
    } catch (error) {
      setUpdates((previous) => ({ ...previous, [name]: 'error' }))
      setBanner(errorBanner(t, error))
    } finally {
      setBusy(null)
    }
  }, [t])

  /**
   * Update one plugin, then clear its check result.
   *
   * The stored verdict describes the version that was checked, so keeping it
   * after an update would leave the row claiming an update is still available
   * for the version just replaced. Clearing returns the row to 'not checked',
   * and the user checks again to see where they now stand.
   */
  const doUpdate = useCallback(async (name: string) => {
    await run(`update:${name}` as Busy, async () => {
      const { result } = await updatePlugin(name)
      setUpdates((previous) => {
        const next = { ...previous }
        delete next[name]
        return next
      })
      return t('update.done', { name, version: result.version })
    })
  }, [run, t])

  const doSelfCheck = useCallback(async () => {
    setBusy('self-check')
    try {
      const check: UpdateCheck = await checkUpdate(self?.name ?? '')
      setSelfCheck(check)
    } catch (error) {
      setSelfCheck('error')
      setBanner(errorBanner(t, error))
    } finally {
      setBusy(null)
    }
  }, [self, t])

  const doSelfUpdate = useCallback(async () => {
    await run('self-update', async () => {
      const { result } = await updateSelf()
      setSelfCheck(undefined)
      return t('update.done', { name: result.name, version: result.version })
    })
  }, [run, t])

  return (
    <div className='dpm-section' data-deep-plugin-manager>
      <h2 className='dpm-heading'>{t('title')}</h2>
      <p className='dpm-intro'>{t('intro')}</p>
      <p className='dpm-note'>{t('restart.note')}</p>

      {self !== undefined && (
        <SelfCard
          self={self}
          check={selfCheck}
          busy={busy}
          t={t}
          onCheck={() => { void doSelfCheck() }}
          onUpdate={() => { void doSelfUpdate() }}
        />
      )}

      <div className='dpm-install'>
        <input
          type='text'
          value={input}
          placeholder={t('install.placeholder')}
          onChange={(event) => { setInput(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void doInstall() }}
          disabled={busy !== null}
          aria-label={t('install.placeholder')}
        />
        <button
          type='button'
          className='dpm-button'
          onClick={() => { void doInstall() }}
          disabled={busy !== null || input.trim() === ''}
        >
          {busy === 'install' ? t('install.working') : t('install.button')}
        </button>
      </div>

      {banner !== null && (
        <div className={`dpm-banner ${banner.kind}`} role='status'>
          {banner.text}
          {banner.detail !== undefined && (
            <span>
              <button
                type='button'
                className='dpm-detail-toggle'
                onClick={() => { setShowDetail((visible) => !visible) }}
              >
                {t('error.detail')}
              </button>
              {showDetail && <pre className='dpm-detail'>{banner.detail}</pre>}
            </span>
          )}
        </div>
      )}

      {plugins === undefined
        ? <p className='dpm-empty'>{t('status.working')}</p>
        : plugins.length === 0
          ? <p className='dpm-empty'>{t('list.empty')}</p>
          : (
              <div className='dpm-list'>
                {plugins.map((entry) => (
                  <PluginRow
                    key={entry.name}
                    entry={entry}
                    busy={busy}
                    confirming={confirming === entry.name}
                    update={updates[entry.name]}
                    t={t}
                    onToggle={() => { void doSetEnabled(entry.name, !entry.enabled) }}
                    onUninstall={() => { void doUninstall(entry.name) }}
                    onCheck={() => { void doCheck(entry.name) }}
                    onUpdate={() => { void doUpdate(entry.name) }}
                  />
                ))}
              </div>
            )}
    </div>
  )
}

/**
 * The manager's own update card.
 *
 * The spec the profile records is the source the check runs from, so nothing
 * has to be typed: the button asks GitHub about the repository the manager was
 * already installed from. Update is offered only after a check has actually
 * found something, and disappears again once the update lands.
 */
function SelfCard({
  self, check, busy, t, onCheck, onUpdate,
}: {
  self: SelfInfo
  check: RowState
  busy: Busy | null
  t: LocaleSeat['t']
  onCheck(): void
  onUpdate(): void
}) {
  const short = (sha: string): string => sha.slice(0, 7)
  const done = check !== undefined && check !== 'error' ? check : null
  const verdict = done === null ? null : checkStatusText(done, t, short)
  const canUpdate = updateAvailable(check)
  return (
    <div className='dpm-self'>
      <div className='dpm-main'>
        <div>
          <span className='dpm-name'>{t('self.title')}</span>
          {self.version !== '' && <span className='dpm-version'>{self.version}</span>}
          {canUpdate && done !== null && (
            <span className='dpm-badge'>
              {done.basis === 'commit'
                ? t('update.commitAvailable', { sha: short(done.head?.sha ?? '') })
                : t('update.available', { tag: done.latest?.tag ?? '' })}
            </span>
          )}
        </div>
        <div className='dpm-desc'>{t('self.intro')}</div>
        {verdict !== null && <div className='dpm-verdict'>{verdict}</div>}
        {!self.updatable && self.reason !== undefined && (
          <div className='dpm-verdict muted'>{self.reason}</div>
        )}
      </div>
      <div className='dpm-actions'>
        <button type='button' className='dpm-button quiet' onClick={onCheck} disabled={busy !== null}>
          {busy === 'self-check'
            ? t('action.checking')
            : check === undefined ? t('action.check') : t('self.recheck')}
        </button>
        {canUpdate && (
          <button type='button' className='dpm-button' onClick={onUpdate} disabled={busy !== null}>
            {busy === 'self-update' ? t('action.working') : t('action.update')}
          </button>
        )}
      </div>
    </div>
  )
}

/** One line describing what a completed check found. */
function checkStatusText(check: UpdateCheck, t: LocaleSeat['t'], short: (sha: string) => string): string {
  if (!check.comparable) return t('update.commitUnknown')
  if (check.basis === 'commit') {
    if (check.head === undefined) return t('update.headUnknown')
    return check.updateAvailable
      ? t('update.commitAvailable', { sha: short(check.head.sha) })
      : t('update.commitUptodate')
  }
  if (check.latest === null) return t('update.headUnknown')
  return check.updateAvailable
    ? t('update.available', { tag: check.latest.tag })
    : t('update.uptodate')
}

/** One installed-plugin row: identity, state toggle, and lifecycle actions. */
function PluginRow({
  entry, busy, confirming, update, t, onToggle, onUninstall, onCheck, onUpdate,
}: {
  entry: PluginEntry
  busy: Busy | null
  confirming: boolean
  update: RowState
  t: LocaleSeat['t']
  onToggle(): void
  onUninstall(): void
  onCheck(): void
  onUpdate(): void
}) {
  const rowBusy = (key: string): boolean => busy === key
  const done = update !== undefined && update !== 'error' ? update : null
  const canUpdate = updateAvailable(update)
  return (
    <div className='dpm-row'>
      <div className='dpm-main'>
        <div>
          <span className='dpm-name'>{entry.displayName ?? entry.name}</span>
          {entry.version !== '' && <span className='dpm-version'>{entry.version}</span>}
          {canUpdate && done !== null && (
            <span className='dpm-badge'>
              {done.basis === 'commit'
                ? t('update.commitAvailable', { sha: (done.head?.sha ?? '').slice(0, 7) })
                : t('update.available', { tag: done.latest?.tag ?? '' })}
            </span>
          )}
        </div>
        {done !== null && (
          <div className='dpm-verdict'>
            {checkStatusText(done, t, (sha) => sha.slice(0, 7))}
          </div>
        )}
        <div className='dpm-spec' title={entry.spec}>
          {t('managed.by', { spec: entry.spec })}
          {entry.displayName !== undefined && entry.displayName !== entry.name && (
            <span className='dpm-pkg'> · {entry.name}</span>
          )}
        </div>
        {entry.description !== undefined && <div className='dpm-desc'>{entry.description}</div>}
      </div>
      {entry.patchMounted
        ? (
            <span className='dpm-state' title={t('restart.note')}>
              {t('enabled.patch')}
            </span>
          )
        : (
            <button
              type='button'
              role='switch'
              aria-checked={entry.enabled}
              className='dpm-switch'
              onClick={onToggle}
              disabled={busy !== null}
              aria-label={`${entry.name} — ${entry.enabled ? t('enabled.on') : t('enabled.off')}`}
            />
          )}
      <div className='dpm-actions'>
        <button
          type='button'
          className='dpm-button quiet'
          onClick={onCheck}
          disabled={busy !== null}
        >
          {rowBusy(`check:${entry.name}`) ? t('action.checking') : t('action.check')}
        </button>
        {/* Offered only once a check has found something newer. A check that
            came back up to date must not leave a button that would run pnpm
            for a package already at the latest version. */}
        {canUpdate && (
          <button
            type='button'
            className='dpm-button quiet'
            onClick={onUpdate}
            disabled={busy !== null}
          >
            {rowBusy(`update:${entry.name}`) ? t('action.working') : t('action.update')}
          </button>
        )}
        <button
          type='button'
          className='dpm-button danger'
          onClick={onUninstall}
          disabled={busy !== null}
        >
          {confirming || rowBusy(`uninstall:${entry.name}`) ? t('action.confirmUninstall') : t('action.uninstall')}
        </button>
      </div>
    </div>
  )
}

/** Map one thrown failure to a banner. */
function errorBanner(t: LocaleSeat['t'], error: unknown): Banner {
  if (error instanceof ApiError) {
    return { kind: 'error', text: t('error.generic', { message: error.message }), ...(error.detail === undefined ? {} : { detail: error.detail }) }
  }
  return { kind: 'error', text: t('error.generic', { message: error instanceof Error ? error.message : String(error) }) }
}
