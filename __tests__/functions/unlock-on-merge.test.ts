import assert from 'node:assert/strict'
import {beforeEach, mock, test} from 'node:test'
import {COLORS} from '../../src/functions/colors.ts'
import {API_HEADERS} from '../../src/functions/api-headers.ts'
import type {UnlockOnMergeOctokit} from '../../src/functions/unlock-on-merge.ts'
import type {
  BranchDeployContext,
  LockData,
  PullRequestContext
} from '../../src/types.ts'
import {createContext, createOctokit} from '../test-helpers.ts'
import {
  assertCalledWith,
  assertNotCalled,
  createMock,
  queueMockImplementation,
  installModuleMock
} from '../node-test-helpers.ts'
import {unsafeInvalidValue} from '../unsafe-fixtures.ts'

type ActionsCore = typeof import('../../src/actions-core.ts')
type CheckLockFile = typeof import('../../src/functions/check-lock-file.ts')
type UnlockIfUnchanged =
  typeof import('../../src/functions/unlock-if-unchanged.ts')

const debugMock = createMock<ActionsCore['debug']>()
const infoMock = createMock<ActionsCore['info']>()
const setOutputMock = createMock<ActionsCore['setOutput']>()
const warningMock = createMock<ActionsCore['warning']>()
const checkLockFileMock = createMock<CheckLockFile['checkLockFile']>()
const unlockIfUnchangedMock =
  createMock<UnlockIfUnchanged['unlockIfUnchanged']>()
const getBranchMock =
  createMock<UnlockOnMergeOctokit['rest']['repos']['getBranch']>()

installModuleMock(mock, new URL('../../src/actions-core.ts', import.meta.url), {
  debug: debugMock,
  info: infoMock,
  setOutput: setOutputMock,
  warning: warningMock
})
installModuleMock(
  mock,
  new URL('../../src/functions/check-lock-file.ts', import.meta.url),
  {checkLockFile: checkLockFileMock}
)
installModuleMock(
  mock,
  new URL('../../src/functions/unlock-if-unchanged.ts', import.meta.url),
  {unlockIfUnchanged: unlockIfUnchangedMock}
)

const {unlockOnMerge} = await import('../../src/functions/unlock-on-merge.ts')

const environmentTargets = 'production,development,staging'
const lockRefSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const matchingLock = {
  branch: 'acceptance-branch',
  created_at: '2025-01-01T00:00:00Z',
  created_by: 'octocat',
  environment: 'production',
  global: false,
  link: 'https://github.com/corp/test/pull/123#issuecomment-123456789',
  reason: null,
  sticky: true,
  unlock_command: '.unlock production'
} satisfies LockData

let context: PullRequestContext
let octokit: UnlockOnMergeOctokit

function pullRequestContext(
  action: string,
  merged: boolean
): PullRequestContext {
  return {
    ...createContext({
      eventName: 'pull_request',
      issue: {number: 123},
      repo: {owner: 'corp', repo: 'test'}
    }),
    payload: {
      action,
      pull_request: {merged, number: 123}
    }
  }
}

beforeEach(() => {
  for (const mockFunction of [
    debugMock,
    infoMock,
    setOutputMock,
    warningMock,
    checkLockFileMock,
    unlockIfUnchangedMock,
    getBranchMock
  ]) {
    mockFunction.mock.resetCalls()
  }

  unlockIfUnchangedMock.mock.mockImplementation(() => Promise.resolve(true))
  checkLockFileMock.mock.mockImplementation(() => Promise.resolve(matchingLock))
  getBranchMock.mock.mockImplementation(() =>
    Promise.resolve({data: {commit: {sha: lockRefSha}}})
  )

  context = pullRequestContext('closed', true)
  const client = createOctokit()
  octokit = {
    ...client,
    rest: {
      ...client.rest,
      repos: {...client.rest.repos, getBranch: getBranchMock}
    }
  }
})

test('successfully unlocks all environments on a pull request merge', async () => {
  assert.strictEqual(
    await unlockOnMerge(octokit, context, environmentTargets),
    true
  )
  assertCalledWith(
    infoMock,
    `🔓 removed lock - environment: ${COLORS.highlight}staging${COLORS.reset}`
  )
  assertCalledWith(
    infoMock,
    `🔓 removed lock - environment: ${COLORS.highlight}development${COLORS.reset}`
  )
  assertCalledWith(
    infoMock,
    `🔓 removed lock - environment: ${COLORS.highlight}production${COLORS.reset}`
  )
  assertCalledWith(
    setOutputMock,
    'unlocked_environments',
    'production,development,staging'
  )
})

test('trims whitespace around environment targets before unlocking', async () => {
  assert.strictEqual(
    await unlockOnMerge(
      octokit,
      context,
      ' production ,\tdevelopment, staging '
    ),
    true
  )

  for (const environment of ['production', 'development', 'staging']) {
    assertCalledWith(getBranchMock, {
      owner: 'corp',
      repo: 'test',
      branch: `${environment}-branch-deploy-lock`,
      headers: API_HEADERS
    })
    assertCalledWith(checkLockFileMock, octokit, context, lockRefSha)
    assertCalledWith(
      unlockIfUnchangedMock,
      octokit,
      context,
      environment,
      lockRefSha
    )
  }

  assertCalledWith(
    setOutputMock,
    'unlocked_environments',
    'production,development,staging'
  )
})

test('binds lock ownership and deletion to each observed lock ref', async () => {
  const observedLocks = [
    ['production', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['development', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    ['staging', 'cccccccccccccccccccccccccccccccccccccccc']
  ] as const
  queueMockImplementation(
    getBranchMock,
    ...observedLocks.map(
      ([, sha]) =>
        () =>
          Promise.resolve({data: {commit: {sha}}})
    )
  )

  assert.strictEqual(
    await unlockOnMerge(octokit, context, environmentTargets),
    true
  )

  for (const [environment, sha] of observedLocks) {
    assertCalledWith(checkLockFileMock, octokit, context, sha)
    assertCalledWith(unlockIfUnchangedMock, octokit, context, environment, sha)
  }
})

test('leaves replacement locks in place when conditional removal fails', async () => {
  unlockIfUnchangedMock.mock.mockImplementation(() => Promise.resolve(false))

  assert.strictEqual(
    await unlockOnMerge(octokit, context, environmentTargets),
    true
  )
  assertCalledWith(
    infoMock,
    `⏩ original lock could not be removed for environment ${COLORS.highlight}production${COLORS.reset} - leaving the current lock in place`
  )
  assertCalledWith(setOutputMock, 'unlocked_environments', '')
})

test('fails closed when the current lock cannot be inspected', async () => {
  getBranchMock.mock.mockImplementation(() =>
    Promise.reject(Object.assign(new Error('server error'), {status: 500}))
  )

  await assert.rejects(
    unlockOnMerge(octokit, context, environmentTargets),
    new Error('Could not inspect the current deployment lock')
  )
  assertNotCalled(checkLockFileMock)
  assertNotCalled(unlockIfUnchangedMock)
})

test('only unlocks one environment when another belongs to a different pull request and one has no lock file', async () => {
  queueMockImplementation(
    checkLockFileMock,
    () =>
      Promise.resolve({
        ...matchingLock,
        link: 'https://github.com/corp/test/pull/111#issuecomment-123456789'
      }),
    () => Promise.resolve(false)
  )

  assert.strictEqual(
    await unlockOnMerge(octokit, context, environmentTargets),
    true
  )
  assertCalledWith(
    infoMock,
    `⏩ lock for PR ${COLORS.info}111${COLORS.reset} (env: ${COLORS.highlight}production${COLORS.reset}) is not associated with PR ${COLORS.info}123${COLORS.reset} - skipping...`
  )
  assertCalledWith(
    infoMock,
    `⏩ no lock file found for environment ${COLORS.highlight}development${COLORS.reset} - skipping...`
  )
  assertCalledWith(
    infoMock,
    `🔓 removed lock - environment: ${COLORS.highlight}staging${COLORS.reset}`
  )
})

test('preserves legacy truthiness for malformed falsy lock data', async () => {
  queueMockImplementation(checkLockFileMock, () =>
    Promise.resolve(unsafeInvalidValue<LockData>(null))
  )

  assert.strictEqual(
    await unlockOnMerge(octokit, context, environmentTargets),
    true
  )
  assertCalledWith(
    infoMock,
    `⏩ no lock file found for environment ${COLORS.highlight}production${COLORS.reset} - skipping...`
  )
  assertCalledWith(
    setOutputMock,
    'unlocked_environments',
    'development,staging'
  )
})

test('only unlocks one environment when another belongs to a different pull request and one has no lock branch', async () => {
  queueMockImplementation(checkLockFileMock, () =>
    Promise.resolve({
      ...matchingLock,
      link: 'https://github.com/corp/test/pull/111#issuecomment-123456789'
    })
  )
  queueMockImplementation(
    getBranchMock,
    () => Promise.resolve({data: {commit: {sha: lockRefSha}}}),
    () => Promise.reject(Object.assign(new Error('not found'), {status: 404}))
  )

  assert.strictEqual(
    await unlockOnMerge(octokit, context, environmentTargets),
    true
  )
  assertCalledWith(
    infoMock,
    `⏩ lock for PR ${COLORS.info}111${COLORS.reset} (env: ${COLORS.highlight}production${COLORS.reset}) is not associated with PR ${COLORS.info}123${COLORS.reset} - skipping...`
  )
  assertCalledWith(
    infoMock,
    `⏩ no lock branch found for environment ${COLORS.highlight}development${COLORS.reset} - skipping...`
  )
  assertCalledWith(
    infoMock,
    `🔓 removed lock - environment: ${COLORS.highlight}staging${COLORS.reset}`
  )
})

test('fails when the context is not a pull request merge', async () => {
  context = pullRequestContext('opened', false)

  assert.strictEqual(
    await unlockOnMerge(octokit, context, environmentTargets),
    false
  )
  assertCalledWith(
    infoMock,
    'event name: pull_request, action: opened, merged: false'
  )
  assertCalledWith(
    warningMock,
    `this workflow can only run in the context of a ${COLORS.highlight}merged${COLORS.reset} pull request`
  )
})

test('fails for a pull request closed without being merged', async () => {
  context = pullRequestContext('closed', false)

  assert.strictEqual(
    await unlockOnMerge(octokit, context, environmentTargets),
    false
  )
  assertCalledWith(
    warningMock,
    `this workflow can only run in the context of a ${COLORS.highlight}merged${COLORS.reset} pull request`
  )
  assertCalledWith(
    infoMock,
    'event name: pull_request, action: closed, merged: false'
  )
  assertCalledWith(
    infoMock,
    'pull request was closed but not merged so this workflow will not run - OK'
  )
})

for (const payload of [null, undefined]) {
  test(`safe-exits when the webhook payload is ${String(payload)}`, async () => {
    const malformedContext = unsafeInvalidValue<BranchDeployContext>({
      ...context,
      payload
    })
    assert.strictEqual(
      await unlockOnMerge(octokit, malformedContext, environmentTargets),
      false
    )
    assertCalledWith(
      infoMock,
      'event name: pull_request, action: undefined, merged: undefined'
    )
    assertNotCalled(getBranchMock)
  })
}
