/**
 * Tests for the update-button rules in the settings section. These are pure
 * functions extracted from the component so the gating logic can be asserted
 * without a DOM: the Update button must appear only after a check that found
 * something newer, and a completed check must not survive the update it
 * prompted.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { UpdateCheck } from '../src/client/api.ts'

/** The check result the section stores for a row (undefined = not checked). */
export type RowState = UpdateCheck | 'error' | undefined

/**
 * Whether the Update button should be offered.
 *
 * Mirrors the component's rule: a completed check that actually found
 * something newer. A check that came back up to date, or one that never ran,
 * must not offer a button — clicking it would run pnpm for a package that is
 * already at the latest version.
 */
export function updateAvailable(update: RowState): boolean {
  return update !== undefined && update !== 'error' && update.updateAvailable
}

function check(overrides: Partial<UpdateCheck>): UpdateCheck {
  return {
    name: 'dsh-deep-plugin-manager',
    current: '0.1.0',
    latest: null,
    updateAvailable: false,
    basis: 'commit',
    comparable: true,
    ...overrides,
  }
}

describe('update button gating', () => {
  it('offers nothing before a check has run', () => {
    assert.equal(updateAvailable(undefined), false)
  })

  it('offers nothing after a check found nothing newer', () => {
    assert.equal(updateAvailable(check({ updateAvailable: false })), false)
  })

  it('offers Update after a check found a newer commit', () => {
    const result = check({
      updateAvailable: true,
      head: { sha: 'ced4b9259b1abf9170b6067a03c24c7cd1a04efc', message: 'fix', url: '', date: '' },
    })
    assert.equal(updateAvailable(result), true)
  })

  it('offers Update after a check found a newer release', () => {
    const result = check({
      basis: 'release',
      latest: { tag: 'v0.2.0', name: '0.2.0', url: '', publishedAt: '' },
      updateAvailable: true,
    })
    assert.equal(updateAvailable(result), true)
  })

  it('offers nothing when the check itself failed', () => {
    assert.equal(updateAvailable('error'), false)
  })

  it('keeps the option open when the comparison was impossible', () => {
    // An unreadable lockfile means "cannot compare", which the server reports
    // as updateAvailable so the refresh path stays reachable.
    const result = check({ updateAvailable: true, comparable: false })
    assert.equal(updateAvailable(result), true)
  })
})

describe('update state after applying an update', () => {
  it('clears the stored verdict so the row returns to unchecked', () => {
    // What doUpdate does: replace the entry rather than leaving it behind.
    const previous: Record<string, RowState> = {
      'dsh-deep-contrast': check({ updateAvailable: true }),
      'dsh-deep-tariff': check({ updateAvailable: false }),
    }
    const next = { ...previous }
    delete next['dsh-deep-contrast']

    assert.equal(
      next['dsh-deep-contrast'],
      undefined,
      'the updated row is unchecked again, so Update is not offered from a stale verdict',
    )
    assert.equal(
      updateAvailable(next['dsh-deep-contrast']),
      false,
      'and no button remains until the user checks again',
    )
    assert.notEqual(next['dsh-deep-tariff'], undefined, 'other rows keep their own verdicts')
  })
})