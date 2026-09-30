import * as core from '../actions-core.ts'
import {unlockIfUnchanged} from './unlock-if-unchanged.ts'
import {LOCK_METADATA} from './lock-metadata.ts'
import {checkLockFile} from './check-lock-file.ts'
import {constructValidBranchName} from './valid-branch-name.ts'
import {COLORS} from './colors.ts'
import {API_HEADERS} from './api-headers.ts'
import {setActionOutput} from '../action-io.ts'
import {
  legacyArrayElement,
  legacyApiError,
  legacyPullRequestEvent,
  legacyTruthy
} from '../trust-boundaries.ts'
import type {LockFileOctokit} from './check-lock-file.ts'
import type {ConditionalUnlockOctokit} from './unlock-if-unchanged.ts'
import type {BranchDeployContext, BranchDeployOctokit} from '../types.ts'

type GetBranchMethod = BranchDeployOctokit['rest']['repos']['getBranch']
type GetBranchParameters = Parameters<GetBranchMethod>[0]

export type UnlockOnMergeOctokit = ConditionalUnlockOctokit &
  LockFileOctokit & {
    readonly rest: {
      readonly repos: {
        readonly getBranch: (
          parameters?: GetBranchParameters
        ) => Promise<{readonly data: {readonly commit: {readonly sha: string}}}>
      }
    }
  }

async function currentLockRef(
  octokit: UnlockOnMergeOctokit,
  context: BranchDeployContext,
  lockBranch: string
): Promise<string | null> {
  try {
    const branch = await octokit.rest.repos.getBranch({
      ...context.repo,
      branch: lockBranch,
      headers: API_HEADERS
    })
    return branch.data.commit.sha
  } catch (error) {
    if (legacyApiError(error).status === 404) return null
    throw new Error('Could not inspect the current deployment lock')
  }
}

// Helper function to automatically find, and release a deployment lock when a pull request is merged
// :param octokit: the authenticated octokit instance
// :param context: the context object
// :param environment_targets: the environment targets to check for unlocking
// :return: true if all locks were released successfully, false otherwise
export async function unlockOnMerge(
  octokit: UnlockOnMergeOctokit,
  context: BranchDeployContext,
  environment_targets: string
): Promise<boolean> {
  const event = legacyPullRequestEvent(context)
  const pullRequest = event.pullRequest
  // first, check the context to ensure that the event is a pull request 'closed' event and that the pull request was merged
  if (
    event.eventName !== 'pull_request' ||
    event.action !== 'closed' ||
    pullRequest?.merged !== true
  ) {
    core.warning(
      `this workflow can only run in the context of a ${COLORS.highlight}merged${COLORS.reset} pull request`
    )
    core.info(
      `event name: ${String(event.eventName)}, action: ${String(event.action)}, merged: ${String(pullRequest?.merged)}`
    )

    // many pull requests in a project will end up being closed without being merged, so we can just log this so its clear
    if (event.action === 'closed') {
      core.info(
        `pull request was closed but not merged so this workflow will not run - OK`
      )
    }

    return false
  }

  // loop through all the environment targets and check each one for a lock associated with this merged pull request
  const releasedEnvironments: string[] = []
  for (const rawEnvironment of environment_targets.split(',')) {
    const environment = rawEnvironment.trim()
    // construct the lock branch name for this environment
    const lockBranch = `${constructValidBranchName(environment)}-${LOCK_METADATA.lockBranchSuffix}`

    // Read the exact lock ref so ownership and deletion are bound to the same lock.
    const lockRefSha = await currentLockRef(octokit, context, lockBranch)

    // if the lock branch does not exist at all, then there is no lock to release
    if (lockRefSha === null) {
      core.info(
        `⏩ no lock branch found for environment ${COLORS.highlight}${environment}${COLORS.reset} - skipping...`
      )
      continue
    }

    // attempt to fetch the lockFile for this branch
    const lockFile = await checkLockFile(octokit, context, lockRefSha)

    // check to see if the lockFile exists and if it does, check to see if it has a link property
    if (legacyTruthy(lockFile) && legacyTruthy(lockFile.link)) {
      // if the lockFile has a link property, find the PR number from the link
      const prNumber = legacyArrayElement(
        legacyArrayElement(lockFile.link.split('/pull/')[1]).split(
          '#issuecomment'
        )[0]
      )
      core.info(
        `🔍 checking lock for PR ${COLORS.info}${prNumber}${COLORS.reset} (env: ${COLORS.highlight}${environment}${COLORS.reset})`
      )

      // if the PR number matches the PR number of the merged pull request, then this lock is associated with the merged pull request
      if (prNumber === pullRequest.number.toString()) {
        const removed = await unlockIfUnchanged(
          octokit,
          context,
          environment,
          lockRefSha
        )

        if (removed) {
          releasedEnvironments.push(environment)
          core.info(
            `🔓 removed lock - environment: ${COLORS.highlight}${environment}${COLORS.reset}`
          )
        } else {
          core.info(
            `⏩ original lock could not be removed for environment ${COLORS.highlight}${environment}${COLORS.reset} - leaving the current lock in place`
          )
        }
      } else {
        core.info(
          `⏩ lock for PR ${COLORS.info}${prNumber}${COLORS.reset} (env: ${COLORS.highlight}${environment}${COLORS.reset}) is not associated with PR ${COLORS.info}${pullRequest.number}${COLORS.reset} - skipping...`
        )
      }
    } else {
      core.info(
        `⏩ no lock file found for environment ${COLORS.highlight}${environment}${COLORS.reset} - skipping...`
      )
      continue
    }
  }

  // if we get here, all locks had a best effort attempt to be released
  setActionOutput('unlocked_environments', releasedEnvironments.join(','))
  return true
}
