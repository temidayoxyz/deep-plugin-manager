/** Tests for profile resolution, manifest read/write, and plugin listing. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { os, path } from './helpers.ts'
import { describe, it } from 'node:test'
import {
  isReservedName, listPlugins, readManifest, resolveProfileDir, writeManifest,
} from '../src/profile.ts'
import { ManagerError } from '../src/errors.ts'

const { tmpdir } = os
const { join } = path

function makeTempProfile(): string {
  return mkdtempSync(join(tmpdir(), 'dpm-profile-'))
}

function writePlugin(profileDir: string, name: string, manifest: Record<string, unknown>): void {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

describe('resolveProfileDir', () => {
  it('finds the nearest ancestor manifest declaring dsh.profile', () => {
    const profileDir = makeTempProfile()
    try {
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'profile', dsh: { profile: { bundles: [] } },
      }))
      const deep = join(profileDir, 'node_modules', 'x', 'lib')
      mkdirSync(deep, { recursive: true })
      const fileUrl = `file:///${deep.replaceAll('\\', '/')}/index.js`.replace('file:///', 'file:///')
      assert.equal(resolveProfileDir(fileUrl), profileDir)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('throws when no ancestor declares a profile', () => {
    const bare = makeTempProfile()
    try {
      assert.throws(() => resolveProfileDir(`file:///${bare.replaceAll('\\', '/')}/index.js`), ManagerError)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('profile manifest', () => {
  it('round-trips through the atomic writer', () => {
    const profileDir = makeTempProfile()
    try {
      writeManifest(profileDir, {
        dependencies: { 'dsh-x': 'github:o/x' },
        dsh: { profile: { bundles: ['dsh-x'] } },
      })
      const manifest = readManifest(profileDir)
      assert.equal(manifest.dependencies?.['dsh-x'], 'github:o/x')
      assert.deepEqual(manifest.dsh?.profile?.bundles, ['dsh-x'])
      assert.ok(join(profileDir, 'package.json').length > 0)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('rejects a non-JSON manifest', () => {
    const profileDir = makeTempProfile()
    try {
      writeFileSync(join(profileDir, 'package.json'), '{not json')
      assert.throws(() => readManifest(profileDir), ManagerError)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })
})

describe('listPlugins', () => {
  it('derives entries, enabled state, and skips harness-owned packages', () => {
    const profileDir = makeTempProfile()
    try {
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        dependencies: {
          'dsh-deep-contrast': 'github:t/dc',
          'dsh-deep-tariff': 'github:t/dt',
          '@deepseek-ai/dsh-base': '0.1.5-rc.2',
        },
        dsh: { profile: { bundles: ['dsh-deep-contrast'] } },
      }))
      writePlugin(profileDir, 'dsh-deep-contrast', {
        name: 'dsh-deep-contrast', version: '0.1.0', description: 'theme',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      })
      writePlugin(profileDir, 'dsh-deep-tariff', { name: 'dsh-deep-tariff', version: '1.2.1' })

      const plugins = listPlugins(profileDir)
      assert.equal(plugins.length, 2)
      const contrast = plugins.find((entry) => entry.name === 'dsh-deep-contrast')
      const tariff = plugins.find((entry) => entry.name === 'dsh-deep-tariff')
      assert.equal(contrast?.enabled, true)
      assert.equal(contrast?.version, '0.1.0')
      assert.equal(contrast?.description, 'theme')
      assert.equal(tariff?.enabled, false)
      assert.equal(tariff?.version, '1.2.1')
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('reports a declared-but-missing package instead of hiding it', () => {
    const profileDir = makeTempProfile()
    try {
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        dependencies: { 'dsh-ghost': 'github:o/ghost' },
        dsh: { profile: { bundles: [] } },
      }))
      const plugins = listPlugins(profileDir)
      assert.equal(plugins.length, 1)
      assert.equal(plugins[0]?.name, 'dsh-ghost')
      assert.equal(plugins[0]?.version, '')
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })
})

describe('listPlugins commit reporting', () => {
  it('carries the installed commit so a branch install is identifiable', () => {
    const profileDir = makeTempProfile()
    const SHA = 'ced4b9259b1abf9170b6067a03c24c7cd1a04efc'
    try {
      // Two plugins at the same declared version, on different commits: the
      // version alone cannot tell them apart.
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        dependencies: {
          'dsh-deep-contrast': 'github:t/deep-contrast',
          'dsh-deep-tariff': 'github:t/deep-tariff',
        },
        dsh: { profile: { bundles: [] } },
      }))
      writePlugin(profileDir, 'dsh-deep-contrast', { name: 'dsh-deep-contrast', version: '0.1.0' })
      writePlugin(profileDir, 'dsh-deep-tariff', { name: 'dsh-deep-tariff', version: '0.1.0' })
      writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      dsh-deep-contrast:',
        '        specifier: github:t/deep-contrast',
        `        version: https://codeload.github.com/t/deep-contrast/tar.gz/${SHA}`,
        '      dsh-deep-tariff:',
        '        specifier: github:t/deep-tariff',
        `        version: https://codeload.github.com/t/deep-tariff/tar.gz/${'0'.repeat(39)}1`,
        '',
      ].join('\n'))

      const plugins = listPlugins(profileDir)
      const contrast = plugins.find((entry) => entry.name === 'dsh-deep-contrast')
      const tariff = plugins.find((entry) => entry.name === 'dsh-deep-tariff')
      assert.equal(contrast?.version, '0.1.0')
      assert.equal(contrast?.commit, SHA)
      assert.equal(tariff?.commit, `${'0'.repeat(39)}1`)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('omits the commit when the lockfile cannot answer', () => {
    const profileDir = makeTempProfile()
    try {
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        dependencies: { 'dsh-x': 'npm:dsh-x@1.0.0' },
        dsh: { profile: { bundles: [] } },
      }))
      writePlugin(profileDir, 'dsh-x', { name: 'dsh-x', version: '1.0.0' })
      const plugins = listPlugins(profileDir)
      assert.equal(plugins[0]?.commit, undefined)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })
})

describe('isReservedName', () => {
  it('protects harness packages and the manager itself', () => {
    assert.equal(isReservedName('@deepseek-ai/dsh-base'), true)
    assert.equal(isReservedName('@deepseek-ai/anything'), true)
    assert.equal(isReservedName('dsh-deep-plugin-manager'), true)
    assert.equal(isReservedName('dsh-deep-contrast'), false)
  })
})
