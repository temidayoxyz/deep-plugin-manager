/** Tests for GitHub reference parsing, spec building, and version comparison. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isNewerVersion, parseRepoRef, repoFromSpec, specFor } from '../src/github.ts'
import { InvalidRefError } from '../src/errors.ts'

describe('parseRepoRef', () => {
  it('parses owner/repo', () => {
    assert.deepEqual(parseRepoRef('temidayoxyz/deep-contrast'), { owner: 'temidayoxyz', repo: 'deep-contrast' })
  })

  it('trims whitespace', () => {
    assert.deepEqual(parseRepoRef('  temidayoxyz/deep-contrast  '), { owner: 'temidayoxyz', repo: 'deep-contrast' })
  })

  it('parses owner/repo#ref', () => {
    assert.deepEqual(parseRepoRef('temidayoxyz/deep-contrast#v1.2.0'), {
      owner: 'temidayoxyz',
      repo: 'deep-contrast',
      ref: 'v1.2.0',
    })
  })

  it('parses github: owner/repo', () => {
    assert.deepEqual(parseRepoRef('github:temidayoxyz/deep-contrast'), { owner: 'temidayoxyz', repo: 'deep-contrast' })
  })

  it('parses an https URL with .git and /tree ref', () => {
    assert.deepEqual(
      parseRepoRef('https://github.com/temidayoxyz/deep-contrast.git/tree/v2.0.0'),
      { owner: 'temidayoxyz', repo: 'deep-contrast', ref: 'v2.0.0' },
    )
  })

  it('rejects empty input', () => {
    assert.throws(() => parseRepoRef(''), InvalidRefError)
  })

  it('rejects non-owner/repo shapes', () => {
    assert.throws(() => parseRepoRef('just-a-name'), InvalidRefError)
    assert.throws(() => parseRepoRef('a/b/c/d'), InvalidRefError)
  })

  it('rejects shell metacharacters in the repo reference', () => {
    assert.throws(() => parseRepoRef('owner/repo; rm -rf /'), InvalidRefError)
    assert.throws(() => parseRepoRef('owner/repo & calc'), InvalidRefError)
    assert.throws(() => parseRepoRef('own er/repo'), InvalidRefError)
  })

  it('rejects shell metacharacters in a ref', () => {
    assert.throws(() => parseRepoRef('owner/repo#v1; rm -rf /'), InvalidRefError)
    assert.throws(() => parseRepoRef('owner/repo#$(whoami)'), InvalidRefError)
  })

  it('rejects non-github URLs', () => {
    assert.throws(() => parseRepoRef('https://evil.example.com/owner/repo'), InvalidRefError)
    assert.throws(() => parseRepoRef('http://github.com/owner/repo'), InvalidRefError)
    assert.throws(() => parseRepoRef('file://github.com/owner/repo'), InvalidRefError)
  })

  it('rejects a localhost URL even when the host string looks allowed', () => {
    assert.throws(() => parseRepoRef('https://localhost/owner/repo'), InvalidRefError)
  })
})

describe('specFor', () => {
  it('builds a github spec', () => {
    assert.equal(specFor({ owner: 'temidayoxyz', repo: 'deep-contrast' }), 'github:temidayoxyz/deep-contrast')
  })

  it('appends the ref pin', () => {
    assert.equal(specFor({ owner: 'o', repo: 'r', ref: 'v1.0.0' }), 'github:o/r#v1.0.0')
  })

  it('refuses a spec outside the safe command-line charset', () => {
    assert.throws(() => specFor({ owner: 'o', repo: 'r; echo pwned' }), InvalidRefError)
  })
})

describe('repoFromSpec', () => {
  it('round-trips a github spec', () => {
    assert.deepEqual(repoFromSpec('github:temidayoxyz/deep-contrast'), { owner: 'temidayoxyz', repo: 'deep-contrast' })
  })

  it('returns undefined for non-github specs', () => {
    assert.equal(repoFromSpec('^1.2.3'), undefined)
    assert.equal(repoFromSpec('file:D:/somewhere'), undefined)
  })
})

describe('isNewerVersion', () => {
  it('compares numeric versions per segment', () => {
    assert.equal(isNewerVersion('0.1.0', '0.2.0'), true)
    assert.equal(isNewerVersion('v0.2.0', 'v0.10.0'), true)
    assert.equal(isNewerVersion('1.0.0', '1.0.0'), false)
    assert.equal(isNewerVersion('1.2.3', '1.2.2'), false)
  })

  it('treats differing shapes as changed', () => {
    assert.equal(isNewerVersion('0.1.0', 'nightly'), true)
  })
})
