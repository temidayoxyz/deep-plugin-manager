/**
 * Tests for reading pnpm's recorded commit out of `pnpm-lock.yaml`. The lockfile
 * is the authoritative answer to "which commit is installed", so the parser has
 * to survive quoting, comments, and unrelated entries — and must return
 * `undefined` rather than guess when the shape is not recognized.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { os, path } from './helpers.ts'
import { describe, it } from 'node:test'
import { installedCommit } from '../src/profile.ts'

const { tmpdir } = os
const { join } = path

const SHA_A = 'ced4b9259b1abf9170b6067a03c24c7cd1a04efc'
const SHA_B = '70d8745a4e6a9cc81fb611a506e0d3312b8480a3'

function makeTempProfile(): string {
  return mkdtempSync(join(tmpdir(), 'dpm-lock-'))
}

function writeLock(profileDir: string, body: string): void {
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), body)
}

describe('installedCommit', () => {
  it('reads the resolved commit from the root importer', () => {
    const profileDir = makeTempProfile()
    try {
      writeLock(profileDir, [
        "lockfileVersion: '9.0'",
        '',
        'settings:',
        '  autoInstallPeers: true',
        '',
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      dsh-deep-plugin-manager:',
        '        specifier: github:temidayoxyz/deep-plugin-manager',
        `        version: https://codeload.github.com/temidayoxyz/deep-plugin-manager/tar.gz/${SHA_A}`,
        '',
        'packages:',
        '',
        `  dsh-deep-plugin-manager@https://codeload.github.com/temidayoxyz/deep-plugin-manager/tar.gz/${SHA_A}:`,
        `    resolution: {tarball: https://codeload.github.com/temidayoxyz/deep-plugin-manager/tar.gz/${SHA_A}}`,
        '    version: 0.1.0',
        '',
      ].join('\n'))
      assert.equal(installedCommit(profileDir, 'dsh-deep-plugin-manager'), SHA_A)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('handles a quoted dependency key', () => {
    const profileDir = makeTempProfile()
    try {
      writeLock(profileDir, [
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        "      '@scope/dsh-plugin':",
        '        specifier: github:o/scoped-plugin',
        `        version: https://codeload.github.com/o/scoped-plugin/tar.gz/${SHA_B}`,
        '',
      ].join('\n'))
      assert.equal(installedCommit(profileDir, '@scope/dsh-plugin'), SHA_B)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('reads a pinned spec the same way as an unpinned one', () => {
    const profileDir = makeTempProfile()
    try {
      writeLock(profileDir, [
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      dsh-deep-plugin-manager:',
        `        specifier: github:temidayoxyz/deep-plugin-manager#${SHA_B}`,
        `        version: https://codeload.github.com/temidayoxyz/deep-plugin-manager/tar.gz/${SHA_B}`,
        '',
      ].join('\n'))
      assert.equal(installedCommit(profileDir, 'dsh-deep-plugin-manager'), SHA_B)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('does not answer from a workspace member that shares the dependency', () => {
    const profileDir = makeTempProfile()
    try {
      writeLock(profileDir, [
        'importers:',
        '',
        '  packages/other:',
        '    dependencies:',
        '      dsh-deep-plugin-manager:',
        '        specifier: github:temidayoxyz/deep-plugin-manager',
        `        version: https://codeload.github.com/temidayoxyz/deep-plugin-manager/tar.gz/${SHA_B}`,
        '',
        '  .:',
        '    dependencies:',
        '      dsh-deep-plugin-manager:',
        '        specifier: github:temidayoxyz/deep-plugin-manager',
        `        version: https://codeload.github.com/temidayoxyz/deep-plugin-manager/tar.gz/${SHA_A}`,
        '',
      ].join('\n'))
      assert.equal(
        installedCommit(profileDir, 'dsh-deep-plugin-manager'),
        SHA_A,
        'the root importer wins, not the member that happens to be listed first',
      )
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('returns undefined for a missing lockfile', () => {
    const profileDir = makeTempProfile()
    try {
      assert.equal(installedCommit(profileDir, 'dsh-deep-plugin-manager'), undefined)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('returns undefined for an unlisted dependency', () => {
    const profileDir = makeTempProfile()
    try {
      writeLock(profileDir, [
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      dsh-deep-contrast:',
        '        specifier: github:o/contrast',
        `        version: https://codeload.github.com/o/contrast/tar.gz/${SHA_A}`,
        '',
      ].join('\n'))
      assert.equal(installedCommit(profileDir, 'dsh-deep-plugin-manager'), undefined)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('returns undefined for a non-github spec', () => {
    const profileDir = makeTempProfile()
    try {
      writeLock(profileDir, [
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      dsh-deep-plugin-manager:',
        '        specifier: link:../deep-plugin-manager',
        '        version: link:../deep-plugin-manager',
        '',
      ].join('\n'))
      assert.equal(installedCommit(profileDir, 'dsh-deep-plugin-manager'), undefined)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('returns undefined for a version with no commit in it', () => {
    const profileDir = makeTempProfile()
    try {
      writeLock(profileDir, [
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      dsh-deep-plugin-manager:',
        '        specifier: github:o/repo',
        '        version: 0.1.0',
        '',
      ].join('\n'))
      assert.equal(installedCommit(profileDir, 'dsh-deep-plugin-manager'), undefined)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('returns undefined rather than throwing on a lockfile it cannot parse', () => {
    const profileDir = makeTempProfile()
    try {
      writeLock(profileDir, 'importers:\n  .:\n    dependencies:\n      dsh-x:\n         specifier: github:o/x\n')
      assert.equal(installedCommit(profileDir, 'dsh-deep-plugin-manager'), undefined)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })
})