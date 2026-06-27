export const RELEASE_BASELINE = 'v11.1.5' as const

const RELEASE_VERSION_PATTERN =
  /^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-rc\.([0-9]+))?$/

export interface ReleaseVersion {
  readonly raw: string
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly rc: number | null
}

interface ReleasePolicyBase {
  readonly version: string
  readonly majorTag: string
  readonly assetPrefix: string
}

export interface StableReleasePolicy extends ReleasePolicyBase {
  readonly prerelease: false
  readonly latest: true
  readonly updateMajor: true
}

export interface PrereleaseReleasePolicy extends ReleasePolicyBase {
  readonly prerelease: true
  readonly latest: false
  readonly updateMajor: false
}

export type ReleasePolicy = StableReleasePolicy | PrereleaseReleasePolicy

function parseNumericComponent(
  value: string | undefined,
  input: string
): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Release version contains an unsafe integer: ${input}`)
  }
  return parsed
}

export function parseReleaseVersion(input: string): ReleaseVersion {
  const match = RELEASE_VERSION_PATTERN.exec(input)
  if (match === null) {
    throw new Error(
      `Invalid release version: ${input}. Expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.NUMBER.`
    )
  }

  const rcValue = match[4]
  return {
    raw: input,
    major: parseNumericComponent(match[1], input),
    minor: parseNumericComponent(match[2], input),
    patch: parseNumericComponent(match[3], input),
    rc: rcValue === undefined ? null : parseNumericComponent(rcValue, input)
  }
}

function compareNumber(left: number, right: number): -1 | 0 | 1 {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function compareReleaseVersions(
  left: ReleaseVersion,
  right: ReleaseVersion
): -1 | 0 | 1 {
  for (const comparison of [
    compareNumber(left.major, right.major),
    compareNumber(left.minor, right.minor),
    compareNumber(left.patch, right.patch)
  ]) {
    if (comparison !== 0) return comparison
  }

  if (left.rc === null && right.rc === null) return 0
  if (left.rc === null) return 1
  if (right.rc === null) return -1
  return compareNumber(left.rc, right.rc)
}

function hasSameCoreVersion(
  left: ReleaseVersion,
  right: ReleaseVersion
): boolean {
  return (
    left.major === right.major &&
    left.minor === right.minor &&
    left.patch === right.patch
  )
}

export function createReleasePolicy(input: string): ReleasePolicy {
  const version = parseReleaseVersion(input)
  const shared = {
    version: version.raw,
    majorTag: `v${version.major}`,
    assetPrefix: `branch-deploy-${version.raw}`
  }
  return version.rc === null
    ? {...shared, prerelease: false, latest: true, updateMajor: true}
    : {...shared, prerelease: true, latest: false, updateMajor: false}
}

export function validateReleaseCandidate(input: string): ReleasePolicy {
  const candidate = parseReleaseVersion(input)
  const baseline = parseReleaseVersion(RELEASE_BASELINE)
  if (compareReleaseVersions(candidate, baseline) <= 0) {
    throw new Error(
      `Release version ${candidate.raw} must be greater than automation baseline ${RELEASE_BASELINE}.`
    )
  }
  return createReleasePolicy(candidate.raw)
}

export function validateVersionTransition(
  previousInput: string,
  nextInput: string
): ReleasePolicy {
  const previous = parseReleaseVersion(previousInput)
  const next = parseReleaseVersion(nextInput)

  if (
    previous.rc === null &&
    next.rc !== null &&
    hasSameCoreVersion(previous, next)
  ) {
    throw new Error(
      `Release version cannot move from stable ${previous.raw} to prerelease ${next.raw}.`
    )
  }

  const comparison = compareReleaseVersions(next, previous)
  if (comparison === 0) {
    throw new Error(
      `Release version must change: ${next.raw} is equivalent to ${previous.raw}.`
    )
  }
  if (comparison < 0) {
    throw new Error(
      `Release version must increase: ${next.raw} is older than ${previous.raw}.`
    )
  }

  return validateReleaseCandidate(next.raw)
}
