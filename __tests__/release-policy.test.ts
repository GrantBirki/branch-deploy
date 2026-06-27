import {
  RELEASE_BASELINE,
  compareReleaseVersions,
  createReleasePolicy,
  parseReleaseVersion,
  validateReleaseCandidate,
  validateVersionTransition,
  type PrereleaseReleasePolicy,
  type ReleasePolicy,
  type StableReleasePolicy
} from '../src/release-policy.ts'
import {describe, expect, expectTypeOf, test} from 'vitest'

describe('release version parsing', () => {
  test('parses stable and release-candidate versions', () => {
    expect(parseReleaseVersion('v12.34.56')).toStrictEqual({
      raw: 'v12.34.56',
      major: 12,
      minor: 34,
      patch: 56,
      rc: null
    })
    expect(parseReleaseVersion('v12.34.56-rc.78')).toStrictEqual({
      raw: 'v12.34.56-rc.78',
      major: 12,
      minor: 34,
      patch: 56,
      rc: 78
    })
  })

  test.each([
    '',
    '11.1.6',
    'v11.1',
    'v11.1.6-beta.1',
    'v11.1.6-rc',
    'v11.1.6-rc.-1',
    'v11.1.6+build'
  ])('rejects malformed version %j', version => {
    expect(() => parseReleaseVersion(version)).toThrow(
      `Invalid release version: ${version}`
    )
  })

  test('rejects numeric components that cannot be compared safely', () => {
    expect(() => parseReleaseVersion('v9007199254740992.0.0')).toThrow(
      'Release version contains an unsafe integer'
    )
  })
})

describe('release version ordering', () => {
  test.each([
    ['v2.0.0', 'v1.9.9', 1],
    ['v1.9.0', 'v1.8.99', 1],
    ['v1.8.99', 'v1.8.98', 1],
    ['v1.8.99', 'v1.8.99-rc.99', 1],
    ['v1.8.99-rc.2', 'v1.8.99-rc.1', 1],
    ['v1.8.99', 'v1.8.99', 0],
    ['v1.8.99-rc.1', 'v1.8.99-rc.1', 0],
    ['v1.0.0', 'v2.0.0', -1],
    ['v1.8.0', 'v1.9.0', -1],
    ['v1.8.98', 'v1.8.99', -1],
    ['v1.8.99-rc.1', 'v1.8.99', -1],
    ['v1.8.99-rc.1', 'v1.8.99-rc.2', -1]
  ])('compares %s with %s', (left, right, expected) => {
    expect(
      compareReleaseVersions(
        parseReleaseVersion(left),
        parseReleaseVersion(right)
      )
    ).toBe(expected)
  })
})

describe('release policy', () => {
  test('describes stable releases', () => {
    expect(createReleasePolicy('v12.0.0')).toStrictEqual({
      version: 'v12.0.0',
      prerelease: false,
      latest: true,
      updateMajor: true,
      majorTag: 'v12',
      assetPrefix: 'branch-deploy-v12.0.0'
    })
  })

  test('describes prereleases', () => {
    expect(createReleasePolicy('v12.0.0-rc.10')).toStrictEqual({
      version: 'v12.0.0-rc.10',
      prerelease: true,
      latest: false,
      updateMajor: false,
      majorTag: 'v12',
      assetPrefix: 'branch-deploy-v12.0.0-rc.10'
    })
  })

  test('correlates stable and prerelease policy flags in the type system', () => {
    const assertPolicy = (policy: ReleasePolicy) => {
      if (policy.prerelease) {
        expectTypeOf(policy).toEqualTypeOf<PrereleaseReleasePolicy>()
        expectTypeOf(policy.latest).toEqualTypeOf<false>()
        expectTypeOf(policy.updateMajor).toEqualTypeOf<false>()
      } else {
        expectTypeOf(policy).toEqualTypeOf<StableReleasePolicy>()
        expectTypeOf(policy.latest).toEqualTypeOf<true>()
        expectTypeOf(policy.updateMajor).toEqualTypeOf<true>()
      }
    }

    assertPolicy(createReleasePolicy('v12.0.0'))
    assertPolicy(createReleasePolicy('v12.0.0-rc.1'))
  })

  test('records and enforces the automation baseline', () => {
    expect(RELEASE_BASELINE).toBe('v11.1.5')
    expect(validateReleaseCandidate('v11.1.6').version).toBe('v11.1.6')
    expect(() => validateReleaseCandidate('v11.1.5')).toThrow(
      'must be greater than automation baseline v11.1.5'
    )
    expect(() => validateReleaseCandidate('v11.1.4')).toThrow(
      'must be greater than automation baseline v11.1.5'
    )
  })
})

describe('release transitions', () => {
  test.each([
    ['v11.1.5', 'v11.1.6-rc.1'],
    ['v11.1.6-rc.1', 'v11.1.6-rc.2'],
    ['v11.1.6-rc.2', 'v11.1.6'],
    ['v11.1.6', 'v11.2.0'],
    ['v11.2.0', 'v12.0.0']
  ])('accepts %s to %s', (previous, next) => {
    expect(validateVersionTransition(previous, next).version).toBe(next)
  })

  test('rejects a stable-to-prerelease transition for the same version', () => {
    expect(() => validateVersionTransition('v11.1.6', 'v11.1.6-rc.1')).toThrow(
      'Release version cannot move from stable v11.1.6 to prerelease v11.1.6-rc.1.'
    )
  })

  test('rejects semantically equivalent versions', () => {
    expect(() => validateVersionTransition('v11.01.06', 'v11.1.6')).toThrow(
      'Release version must change: v11.1.6 is equivalent to v11.01.06.'
    )
  })

  test('rejects downgrades', () => {
    expect(() => validateVersionTransition('v11.1.7', 'v11.1.6')).toThrow(
      'Release version must increase: v11.1.6 is older than v11.1.7.'
    )
  })

  test('rejects an increase that does not clear the automation baseline', () => {
    expect(() => validateVersionTransition('v11.1.4', 'v11.1.5')).toThrow(
      'must be greater than automation baseline v11.1.5'
    )
  })
})
