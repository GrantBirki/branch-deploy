import assert from 'node:assert/strict'
import {
  ACCEPTANCE_REPOSITORY,
  ACCEPTANCE_SHAS,
  createMockState,
  mockErrorMessage,
  mockServerCloseAction,
  mockServerPort,
  seedLock,
  setTriggerComment,
  startMockGitHub
} from './mock-github.ts'
import {runAction} from './runner.ts'
import type {
  AcceptanceRunResult,
  MockDeployment,
  MockDeploymentStatus,
  MockGitHubState,
  MockRouteLog,
  ScenarioContext
} from './types.ts'

interface Scenario {
  readonly name: string
  readonly run: () => Promise<void>
}

interface HttpResult {
  readonly body: string
  readonly status: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lockBranch(environment: string): string {
  return `${environment}-branch-deploy-lock`
}

function routeLogForDiagnostics(routeLog: readonly MockRouteLog[]): unknown {
  return routeLog.map(route => ({
    method: route.method,
    path: route.path,
    body: route.body === '' ? '' : route.body.slice(0, 500)
  }))
}

function stateForDiagnostics(state: MockGitHubState): unknown {
  return {
    branches: [...state.branches.keys()].sort(),
    comments: state.comments.map(comment => ({
      id: comment.id,
      body: comment.body.slice(0, 500)
    })),
    deployments: state.deployments.map(deployment => ({
      id: deployment.id,
      environment: deployment.environment,
      ref: deployment.ref,
      sha: deployment.sha,
      statuses: deployment.statuses.map(status => status.state)
    })),
    labels: [...state.labels].sort(),
    pullRequest: state.pullRequest,
    reactions: state.reactions.map(reaction => ({
      commentId: reaction.commentId,
      content: reaction.content,
      id: reaction.id
    })),
    reviewDecision: state.reviewDecision,
    rollupState: state.rollupState
  }
}

function diagnostics(
  context: ScenarioContext,
  result: AcceptanceRunResult | null = null
): string {
  return JSON.stringify(
    {
      stdout: result?.stdout,
      stderr: result?.stderr,
      outputs: result?.output,
      state: result?.state,
      routes: routeLogForDiagnostics(context.routeLog),
      mockState: stateForDiagnostics(context.state)
    },
    null,
    2
  )
}

function requireOutput(
  context: ScenarioContext,
  result: AcceptanceRunResult,
  key: string
): string {
  const value = result.output[key]
  assert.ok(value !== undefined, diagnostics(context, result))
  return value
}

function assertExit(
  context: ScenarioContext,
  result: AcceptanceRunResult,
  code: number
): void {
  assert.equal(result.code, code, diagnostics(context, result))
}

function assertReason(
  context: ScenarioContext,
  result: AcceptanceRunResult,
  reasonCode: string
): void {
  assert.equal(
    requireOutput(context, result, 'reason_code'),
    reasonCode,
    diagnostics(context, result)
  )
}

function assertDecision(
  context: ScenarioContext,
  result: AcceptanceRunResult,
  decision: string
): void {
  assert.equal(
    requireOutput(context, result, 'decision'),
    decision,
    diagnostics(context, result)
  )
}

function assertOutput(
  context: ScenarioContext,
  result: AcceptanceRunResult,
  key: string,
  expected: string
): void {
  assert.equal(
    requireOutput(context, result, key),
    expected,
    diagnostics(context, result)
  )
}

function assertResultField(
  context: ScenarioContext,
  result: AcceptanceRunResult,
  key: string,
  expected: unknown
): void {
  const parsed: unknown = JSON.parse(requireOutput(context, result, 'result'))
  assert.ok(isRecord(parsed), diagnostics(context, result))
  assert.deepEqual(parsed[key], expected, diagnostics(context, result))
}

function assertCommentIncludes(
  context: ScenarioContext,
  fragment: string
): void {
  const matched = context.state.comments.some(comment =>
    comment.body.includes(fragment)
  )
  assert.equal(matched, true, diagnostics(context))
}

function assertReaction(context: ScenarioContext, content: string): void {
  const matched = context.state.reactions.some(
    reaction => reaction.content === content
  )
  assert.equal(matched, true, diagnostics(context))
}

function assertNoDeployment(
  context: ScenarioContext,
  result: AcceptanceRunResult
): void {
  assert.equal(
    context.state.deployments.length,
    0,
    diagnostics(context, result)
  )
}

function requireDeployment(
  context: ScenarioContext,
  index = 0
): MockDeployment {
  const deployment = context.state.deployments[index]
  assert.ok(deployment !== undefined, diagnostics(context))
  return deployment
}

function requireDeploymentStatus(
  context: ScenarioContext,
  deployment: MockDeployment,
  index: number
): MockDeploymentStatus {
  const status = deployment.statuses[index]
  assert.ok(status !== undefined, diagnostics(context))
  return status
}

function setForkPullRequest(state: MockGitHubState): void {
  state.pullRequest = {
    ...state.pullRequest,
    headLabel: 'fork-owner:fork-branch',
    headRef: 'fork-branch',
    headRepoFork: true,
    headRepoFullName: `fork-owner/${ACCEPTANCE_REPOSITORY.repo}`,
    headSha: ACCEPTANCE_SHAS.fork
  }
}

function addBranch(
  state: MockGitHubState,
  name: string,
  sha = ACCEPTANCE_SHAS.default
): void {
  state.branches.set(name, {
    name,
    sha,
    treeSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  })
}

function seedDeployment(
  state: MockGitHubState,
  sha: string,
  environment = 'production'
): void {
  const status = {
    environment,
    environmentUrl: null,
    id: state.nextStatusId,
    state: 'success'
  }
  state.nextStatusId += 1
  state.deployments.push({
    createdAt: '2026-01-01T00:15:00Z',
    environment,
    id: state.nextDeploymentId,
    payload: {type: 'branch-deploy'},
    ref: 'main',
    sha,
    statuses: [status],
    updatedAt: '2026-01-01T00:16:00Z'
  })
  state.nextDeploymentId += 1
}

async function withMockGitHub(
  name: string,
  run: (context: ScenarioContext) => Promise<void>
): Promise<void> {
  const state = createMockState()
  const server = await startMockGitHub(state)
  const context = {
    port: server.port,
    routeLog: server.routeLog,
    state
  }
  try {
    await run(context)
  } catch (error) {
    throw new Error(`${name} failed\n${String(error)}\n${diagnostics(context)}`)
  } finally {
    await server.close()
  }
}

function runMain(
  context: ScenarioContext,
  inputs: Readonly<Record<string, string>> = {}
): Promise<AcceptanceRunResult> {
  return runAction({
    inputs,
    mode: 'main',
    port: context.port,
    previousState: {},
    state: context.state,
    status: 'success'
  })
}

function runPost(
  context: ScenarioContext,
  mainResult: AcceptanceRunResult,
  inputs: Readonly<Record<string, string>> = {},
  status: 'failure' | 'success' = 'success'
): Promise<AcceptanceRunResult> {
  return runAction({
    inputs,
    mode: 'post',
    port: context.port,
    previousState: mainResult.state,
    state: context.state,
    status
  })
}

function getMockRoute(port: number, path: string): Promise<HttpResult> {
  return requestMockRoute(port, path)
}

function requestMockRoute(
  port: number,
  path: string,
  method = 'GET',
  body: Record<string, unknown> | string | undefined = undefined
): Promise<HttpResult> {
  const init: RequestInit = {method}
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = {'content-type': 'application/json'}
  }
  return fetch(`http://127.0.0.1:${port}${path}`, init).then(
    async response => ({
      body: await response.text(),
      status: response.status
    })
  )
}

const scenarios = [
  {
    name: '.help',
    run: () =>
      withMockGitHub('.help', async context => {
        setTriggerComment(context.state, '.help')

        const result = await runMain(context)

        assertExit(context, result, 0)
        assertDecision(context, result, 'complete')
        assertReason(context, result, 'help_completed')
        assertOutput(context, result, 'type', 'help')
        assertCommentIncludes(context, '## 📚 Branch Deployment Help')
        assertReaction(context, '+1')
      })
  },
  {
    name: '.noop',
    run: () =>
      withMockGitHub('.noop', async context => {
        setTriggerComment(context.state, '.noop')
        context.state.reviewDecision = 'REVIEW_REQUIRED'

        const inputs = {
          failed_noop_labels: 'noop-failed',
          successful_noop_labels: 'noop-success'
        }
        const mainResult = await runMain(context, inputs)

        assertExit(context, mainResult, 0)
        assertDecision(context, mainResult, 'continue')
        assertReason(context, mainResult, 'noop_ready')
        assertOutput(context, mainResult, 'continue', 'true')
        assertOutput(context, mainResult, 'noop', 'true')
        assert.equal(
          context.state.branches.has(lockBranch('production')),
          true,
          diagnostics(context, mainResult)
        )
        assertCommentIncludes(context, '### Deployment Triggered 🚀')

        const postResult = await runPost(context, mainResult, inputs)

        assertExit(context, postResult, 0)
        assert.equal(
          context.state.branches.has(lockBranch('production')),
          false,
          diagnostics(context, postResult)
        )
        assert.equal(context.state.labels.has('noop-success'), true)
        assertReaction(context, 'rocket')
      })
  },
  {
    name: '.deploy',
    run: () =>
      withMockGitHub('.deploy', async context => {
        setTriggerComment(context.state, '.deploy')

        const inputs = {
          failed_deploy_labels: 'deploy-failed',
          sticky_locks: 'true',
          successful_deploy_labels: 'deploy-success'
        }
        const mainResult = await runMain(context, inputs)

        assertExit(context, mainResult, 0)
        assertDecision(context, mainResult, 'continue')
        assertReason(context, mainResult, 'deployment_ready')
        assertOutput(context, mainResult, 'continue', 'true')
        assertOutput(context, mainResult, 'noop', 'false')
        const deployment = requireDeployment(context)
        assert.equal(deployment.environment, 'production')
        assert.equal(deployment.ref, 'feature-branch')
        assert.equal(deployment.sha, ACCEPTANCE_SHAS.feature)
        assert.equal(
          requireDeploymentStatus(context, deployment, 0).state,
          'in_progress'
        )
        assert.equal(
          context.state.branches.has(lockBranch('production')),
          true,
          diagnostics(context, mainResult)
        )

        const postResult = await runPost(context, mainResult, inputs)

        assertExit(context, postResult, 0)
        assert.equal(
          requireDeploymentStatus(context, deployment, 1).state,
          'success'
        )
        assert.equal(
          context.state.branches.has(lockBranch('production')),
          true,
          diagnostics(context, postResult)
        )
        assert.equal(context.state.labels.has('deploy-success'), true)
      })
  },
  {
    name: '.wcid',
    run: () =>
      withMockGitHub('.wcid', async context => {
        seedLock(context.state, 'production', 'feature-branch', 'GrantBirki', 1)
        setTriggerComment(context.state, '.wcid')

        const result = await runMain(context)

        assertExit(context, result, 0)
        assertReason(context, result, 'lock_info_completed')
        assertCommentIncludes(context, '### Lock Details 🔒')
        assertCommentIncludes(context, '- __Branch__: `feature-branch`')
      })
  },
  {
    name: '.unlock',
    run: () =>
      withMockGitHub('.unlock', async context => {
        seedLock(context.state, 'production', 'feature-branch', 'GrantBirki', 1)
        setTriggerComment(context.state, '.unlock production')

        const result = await runMain(context)

        assertExit(context, result, 0)
        assertReason(context, result, 'unlock_completed')
        assertOutput(context, result, 'type', 'unlock')
        assert.equal(
          context.state.branches.has(lockBranch('production')),
          false,
          diagnostics(context, result)
        )
        assertCommentIncludes(context, '### 🔓 Deployment Lock Removed')
      })
  },
  {
    name: '.deploy main',
    run: () =>
      withMockGitHub('.deploy main', async context => {
        setTriggerComment(context.state, '.deploy main')
        context.state.reviewDecision = 'REVIEW_REQUIRED'
        context.state.rollupState = 'FAILURE'

        const result = await runMain(context)

        assertExit(context, result, 0)
        assertReason(context, result, 'deployment_ready')
        assertOutput(context, result, 'ref', 'main')
        assertOutput(context, result, 'sha', ACCEPTANCE_SHAS.default)
        const deployment = requireDeployment(context)
        assert.equal(deployment.ref, 'main')
        assert.equal(deployment.sha, ACCEPTANCE_SHAS.default)
      })
  },
  {
    name: 'merge deploy required',
    run: () =>
      withMockGitHub('merge deploy required', async context => {
        seedDeployment(context.state, ACCEPTANCE_SHAS.oldDeployment)

        const result = await runMain(context, {merge_deploy_mode: 'true'})

        assertExit(context, result, 0)
        assertDecision(context, result, 'continue')
        assertReason(context, result, 'merge_deploy_required')
        assertOutput(context, result, 'continue', 'true')
        assertOutput(context, result, 'sha', ACCEPTANCE_SHAS.default)
      })
  },
  {
    name: 'merge deploy already deployed',
    run: () =>
      withMockGitHub('merge deploy already deployed', async context => {
        seedDeployment(context.state, ACCEPTANCE_SHAS.default)

        const result = await runMain(context, {merge_deploy_mode: 'true'})

        assertExit(context, result, 0)
        assertDecision(context, result, 'stop')
        assertReason(context, result, 'merge_deploy_not_required')
        assertOutput(context, result, 'continue', 'false')
      })
  },
  {
    name: 'unlock on merge',
    run: () =>
      withMockGitHub('unlock on merge', async context => {
        seedLock(context.state, 'production', 'feature-branch', 'GrantBirki', 1)
        seedLock(context.state, 'staging', 'other-branch', 'GrantBirki', 99)

        const result = await runMain(context, {
          environment_targets: 'production,staging',
          unlock_on_merge_mode: 'true'
        })

        assertExit(context, result, 0)
        assertReason(context, result, 'unlock_on_merge_completed')
        assertOutput(context, result, 'unlocked_environments', 'production')
        assert.equal(
          context.state.branches.has(lockBranch('production')),
          false,
          diagnostics(context, result)
        )
        assert.equal(
          context.state.branches.has(lockBranch('staging')),
          true,
          diagnostics(context, result)
        )
      })
  },
  {
    name: 'confirmation confirmed',
    run: () =>
      withMockGitHub('confirmation confirmed', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.confirmationReaction = '+1'

        const result = await runMain(context, {
          deployment_confirmation: 'true',
          deployment_confirmation_timeout: '1'
        })

        assertExit(context, result, 0)
        assertReason(context, result, 'deployment_ready')
        assertCommentIncludes(context, 'Deployment confirmed by __GrantBirki__')
        assert.equal(context.state.deployments.length, 1)
      })
  },
  {
    name: 'confirmation rejected',
    run: () =>
      withMockGitHub('confirmation rejected', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.confirmationReaction = '-1'

        const result = await runMain(context, {
          deployment_confirmation: 'true',
          deployment_confirmation_timeout: '1'
        })

        assertExit(context, result, 1)
        assertDecision(context, result, 'failure')
        assertReason(context, result, 'confirmation_rejected')
        assertCommentIncludes(context, 'Deployment rejected by __GrantBirki__')
        assert.equal(
          context.state.branches.has(lockBranch('production')),
          false,
          diagnostics(context, result)
        )
      })
  },
  {
    name: 'confirmation timeout',
    run: () =>
      withMockGitHub('confirmation timeout', async context => {
        setTriggerComment(context.state, '.deploy')

        const result = await runMain(context, {
          deployment_confirmation: 'true',
          deployment_confirmation_timeout: '1'
        })

        assertExit(context, result, 1)
        assertReason(context, result, 'confirmation_timed_out')
        assertCommentIncludes(context, 'Deployment confirmation timed out')
        assert.equal(
          context.state.branches.has(lockBranch('production')),
          false,
          diagnostics(context, result)
        )
      })
  },
  {
    name: 'fork rejected by default',
    run: () =>
      withMockGitHub('fork rejected by default', async context => {
        setTriggerComment(context.state, '.deploy')
        setForkPullRequest(context.state)

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertDecision(context, result, 'failure')
        assertReason(context, result, 'prechecks_failed')
        assertOutput(context, result, 'fork', 'true')
        assertCommentIncludes(context, 'prevent deployments from forks')
      })
  },
  {
    name: 'fork explicit opt-in',
    run: () =>
      withMockGitHub('fork explicit opt-in', async context => {
        setTriggerComment(context.state, '.noop')
        setForkPullRequest(context.state)

        const result = await runMain(context, {allow_forks: 'true'})

        assertExit(context, result, 0)
        assertReason(context, result, 'noop_ready')
        assertOutput(context, result, 'fork', 'true')
        assertOutput(context, result, 'fork_ref', 'fork-branch')
        assertOutput(context, result, 'fork_label', 'fork-owner:fork-branch')
        assertOutput(
          context,
          result,
          'fork_full_name',
          'fork-owner/actions-sandbox'
        )
        assertOutput(context, result, 'ref', ACCEPTANCE_SHAS.fork)
        assertOutput(context, result, 'sha', ACCEPTANCE_SHAS.fork)
      })
  },
  {
    name: 'parameters and environment metadata',
    run: () =>
      withMockGitHub('parameters and environment metadata', async context => {
        setTriggerComment(
          context.state,
          '.deploy to development | --log-level=debug --replicas=2'
        )

        const result = await runMain(context, {
          environment_urls: 'development|https://dev.example.test'
        })

        assertExit(context, result, 0)
        assertReason(context, result, 'deployment_ready')
        assertOutput(context, result, 'environment', 'development')
        assertOutput(
          context,
          result,
          'environment_url',
          'https://dev.example.test'
        )
        assertOutput(
          context,
          result,
          'params',
          '--log-level=debug --replicas=2'
        )
        assert.equal(
          requireOutput(context, result, 'parsed_params').includes(
            '"replicas":2'
          ),
          true,
          diagnostics(context, result)
        )
        assertResultField(context, result, 'environment', 'development')
        const deployment = requireDeployment(context)
        const payload = JSON.stringify(deployment.payload)
        assert.equal(payload.includes('"stable_branch_used":false'), true)
        assert.equal(payload.includes('"replicas":2'), true)
        assert.equal(
          requireDeploymentStatus(context, deployment, 0).environmentUrl,
          'https://dev.example.test'
        )
      })
  },
  {
    name: 'review-required rejection',
    run: () =>
      withMockGitHub('review-required rejection', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.reviewDecision = 'REVIEW_REQUIRED'

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertOutput(context, result, 'commit_status', 'SUCCESS')
        assertCommentIncludes(
          context,
          'approval is required before you can proceed'
        )
      })
  },
  {
    name: 'unavailable CI rejection',
    run: () =>
      withMockGitHub('unavailable CI rejection', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.rollupAvailable = false

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertOutput(context, result, 'commit_status', 'UNAVAILABLE')
        assertCommentIncludes(context, 'commitStatus: `UNAVAILABLE`')
      })
  },
  {
    name: 'permission denied precheck',
    run: () =>
      withMockGitHub('permission denied precheck', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.permission = 'read'

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertNoDeployment(context, result)
        assertCommentIncludes(
          context,
          'command requires the following permission'
        )
      })
  },
  {
    name: 'draft PR rejected by default',
    run: () =>
      withMockGitHub('draft PR rejected by default', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.pullRequest = {...context.state.pullRequest, draft: true}

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertNoDeployment(context, result)
        assertCommentIncludes(context, 'pull request is in a draft state')
      })
  },
  {
    name: 'draft PR permitted target',
    run: () =>
      withMockGitHub('draft PR permitted target', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.pullRequest = {...context.state.pullRequest, draft: true}

        const result = await runMain(context, {
          draft_permitted_targets: 'production'
        })

        assertExit(context, result, 0)
        assertReason(context, result, 'deployment_ready')
        assertOutput(context, result, 'environment', 'production')
        assert.equal(context.state.deployments.length, 1)
      })
  },
  {
    name: 'non-default base rejected',
    run: () =>
      withMockGitHub('non-default base rejected', async context => {
        setTriggerComment(context.state, '.deploy')
        addBranch(context.state, 'release')
        context.state.pullRequest = {
          ...context.state.pullRequest,
          baseRef: 'release'
        }

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertOutput(context, result, 'non_default_target_branch_used', 'true')
        assertNoDeployment(context, result)
        assertCommentIncludes(
          context,
          'not the default branch of this repository'
        )
      })
  },
  {
    name: 'non-default base explicit opt-in',
    run: () =>
      withMockGitHub('non-default base explicit opt-in', async context => {
        setTriggerComment(context.state, '.deploy')
        addBranch(context.state, 'release')
        context.state.pullRequest = {
          ...context.state.pullRequest,
          baseRef: 'release'
        }

        const result = await runMain(context, {
          allow_non_default_target_branch_deployments: 'true',
          use_security_warnings: 'false'
        })

        assertExit(context, result, 0)
        assertReason(context, result, 'deployment_ready')
        assertOutput(context, result, 'non_default_target_branch_used', 'true')
        assert.equal(context.state.deployments.length, 1)
      })
  },
  {
    name: 'CI failure rejection',
    run: () =>
      withMockGitHub('CI failure rejection', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.rollupState = 'FAILURE'

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertOutput(context, result, 'commit_status', 'FAILURE')
        assertNoDeployment(context, result)
        assertCommentIncludes(context, 'CI checks are failing')
      })
  },
  {
    name: 'CI pending rejection',
    run: () =>
      withMockGitHub('CI pending rejection', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.rollupState = 'PENDING'

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertOutput(context, result, 'commit_status', 'PENDING')
        assertNoDeployment(context, result)
        assertCommentIncludes(context, 'CI checks must be passing')
      })
  },
  {
    name: 'no CI checks with approval',
    run: () =>
      withMockGitHub('no CI checks with approval', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.rollupState = null

        const result = await runMain(context)

        assertExit(context, result, 0)
        assertReason(context, result, 'deployment_ready')
        assert.equal(context.state.deployments.length, 1)
      })
  },
  {
    name: 'skip ci bypasses failing rollup',
    run: () =>
      withMockGitHub('skip ci bypasses failing rollup', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.rollupState = 'FAILURE'

        const result = await runMain(context, {skip_ci: 'production'})

        assertExit(context, result, 0)
        assertReason(context, result, 'deployment_ready')
        assertOutput(context, result, 'commit_status', 'skip_ci')
      })
  },
  {
    name: 'skip reviews bypasses review-required',
    run: () =>
      withMockGitHub('skip reviews bypasses review-required', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.reviewDecision = 'REVIEW_REQUIRED'

        const result = await runMain(context, {skip_reviews: 'production'})

        assertExit(context, result, 0)
        assertReason(context, result, 'deployment_ready')
        assertOutput(context, result, 'review_decision', 'skip_reviews')
      })
  },
  {
    name: 'admin bypasses review-required',
    run: () =>
      withMockGitHub('admin bypasses review-required', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.reviewDecision = 'REVIEW_REQUIRED'

        const result = await runMain(context, {admins: 'GrantBirki'})

        assertExit(context, result, 0)
        assertReason(context, result, 'deployment_ready')
        assertOutput(context, result, 'review_decision', 'REVIEW_REQUIRED')
      })
  },
  {
    name: 'noop still waits for pending CI',
    run: () =>
      withMockGitHub('noop still waits for pending CI', async context => {
        setTriggerComment(context.state, '.noop')
        context.state.reviewDecision = 'REVIEW_REQUIRED'
        context.state.rollupState = 'PENDING'

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertOutput(context, result, 'type', 'deploy')
        assertOutput(context, result, 'commit_status', 'PENDING')
        assertNoDeployment(context, result)
        assertCommentIncludes(context, 'CI checks must be passing')
      })
  },
  {
    name: 'outdated branch warn mode rejects',
    run: () =>
      withMockGitHub('outdated branch warn mode rejects', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.mergeStateStatus = 'BEHIND'

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertOutput(context, result, 'is_outdated', 'true')
        assertNoDeployment(context, result)
        assertCommentIncludes(context, 'branch is behind the base branch')
      })
  },
  {
    name: 'outdated branch disabled mode continues',
    run: () =>
      withMockGitHub(
        'outdated branch disabled mode continues',
        async context => {
          setTriggerComment(context.state, '.deploy')
          context.state.mergeStateStatus = 'BEHIND'

          const result = await runMain(context, {update_branch: 'disabled'})

          assertExit(context, result, 0)
          assertReason(context, result, 'deployment_ready')
          assertOutput(context, result, 'is_outdated', 'true')
          assertOutput(context, result, 'merge_state_status', 'BEHIND')
        }
      )
  },
  {
    name: 'outdated branch force update exits',
    run: () =>
      withMockGitHub('outdated branch force update exits', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.mergeStateStatus = 'BEHIND'

        const result = await runMain(context, {update_branch: 'force'})

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertNoDeployment(context, result)
        assertCommentIncludes(context, 'updated your branch with `main`')
      })
  },
  {
    name: 'dirty merge state rejects',
    run: () =>
      withMockGitHub('dirty merge state rejects', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.mergeStateStatus = 'DIRTY'

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertOutput(context, result, 'merge_state_status', 'DIRTY')
        assertNoDeployment(context, result)
        assertCommentIncludes(
          context,
          'A merge commit cannot be cleanly created'
        )
      })
  },
  {
    name: 'deleted branch rejection',
    run: () =>
      withMockGitHub('deleted branch rejection', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.branches.delete('feature-branch')

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertNoDeployment(context, result)
        assertCommentIncludes(
          context,
          'The branch for this pull request no longer exists'
        )
      })
  },
  {
    name: 'graphql commit mismatch rejection',
    run: () =>
      withMockGitHub('graphql commit mismatch rejection', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.graphqlCommitOid = ACCEPTANCE_SHAS.default

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertNoDeployment(context, result)
        assertCommentIncludes(context, 'does not match the commit sha')
      })
  },
  {
    name: 'exact SHA rejected without opt-in',
    run: () =>
      withMockGitHub('exact SHA rejected without opt-in', async context => {
        setTriggerComment(context.state, `.deploy ${ACCEPTANCE_SHAS.default}`)

        const result = await runMain(context)

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertNoDeployment(context, result)
        assertCommentIncludes(context, 'sha deployments have not been enabled')
      })
  },
  {
    name: 'exact SHA explicit opt-in',
    run: () =>
      withMockGitHub('exact SHA explicit opt-in', async context => {
        setTriggerComment(context.state, `.deploy ${ACCEPTANCE_SHAS.default}`)

        const result = await runMain(context, {allow_sha_deployments: 'true'})

        assertExit(context, result, 0)
        assertReason(context, result, 'deployment_ready')
        assertOutput(context, result, 'sha_deployment', ACCEPTANCE_SHAS.default)
        assertOutput(context, result, 'ref', ACCEPTANCE_SHAS.default)
        assertOutput(context, result, 'sha', ACCEPTANCE_SHAS.default)
        assert.equal(requireDeployment(context).ref, ACCEPTANCE_SHAS.default)
      })
  },
  {
    name: 'required checks ignore optional failure',
    run: () =>
      withMockGitHub(
        'required checks ignore optional failure',
        async context => {
          setTriggerComment(context.state, '.deploy')
          context.state.rollupState = 'FAILURE'
          context.state.rollupContexts = [
            {
              conclusion: 'SUCCESS',
              isRequired: true,
              name: 'acceptance',
              type: 'check-run'
            },
            {
              conclusion: 'FAILURE',
              isRequired: false,
              name: 'optional-lint',
              type: 'check-run'
            }
          ]

          const result = await runMain(context, {checks: 'required'})

          assertExit(context, result, 0)
          assertReason(context, result, 'deployment_ready')
          assertOutput(context, result, 'commit_status', 'SUCCESS')
        }
      )
  },
  {
    name: 'ignored failing check allows all checks',
    run: () =>
      withMockGitHub(
        'ignored failing check allows all checks',
        async context => {
          setTriggerComment(context.state, '.deploy')
          context.state.rollupState = 'FAILURE'
          context.state.rollupContexts = [
            {
              conclusion: 'SUCCESS',
              isRequired: true,
              name: 'acceptance',
              type: 'check-run'
            },
            {
              conclusion: 'FAILURE',
              isRequired: true,
              name: 'flaky-ci',
              type: 'check-run'
            }
          ]

          const result = await runMain(context, {ignored_checks: 'flaky-ci'})

          assertExit(context, result, 0)
          assertReason(context, result, 'deployment_ready')
          assertOutput(context, result, 'commit_status', 'SUCCESS')
        }
      )
  },
  {
    name: 'explicit check list missing check',
    run: () =>
      withMockGitHub('explicit check list missing check', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.rollupContexts = [
          {
            conclusion: 'SUCCESS',
            isRequired: true,
            name: 'security',
            type: 'check-run'
          }
        ]

        const result = await runMain(context, {checks: 'security,build'})

        assertExit(context, result, 1)
        assertReason(context, result, 'prechecks_failed')
        assertOutput(context, result, 'commit_status', 'MISSING')
        assertNoDeployment(context, result)
        assertCommentIncludes(context, 'following checks are missing: `build`')
      })
  },
  {
    name: 'status context explicit check passes',
    run: () =>
      withMockGitHub('status context explicit check passes', async context => {
        setTriggerComment(context.state, '.deploy')
        context.state.rollupContexts = [
          {
            context: 'legacy-ci',
            isRequired: true,
            state: 'SUCCESS',
            type: 'status-context'
          }
        ]

        const result = await runMain(context, {checks: 'legacy-ci'})

        assertExit(context, result, 0)
        assertReason(context, result, 'deployment_ready')
        assertOutput(context, result, 'commit_status', 'SUCCESS')
      })
  },
  {
    name: 'reaction failure is best effort',
    run: () =>
      withMockGitHub('reaction failure is best effort', async context => {
        setTriggerComment(context.state, '.help')
        context.state.failInitialReaction = true

        const result = await runMain(context)

        assertExit(context, result, 0)
        assertReason(context, result, 'help_completed')
        assertCommentIncludes(context, '## 📚 Branch Deployment Help')
        assert.equal(
          result.stdout.includes('failed to add the initial reaction'),
          true,
          diagnostics(context, result)
        )
      })
  },
  {
    name: 'mock GraphQL deployment lookup',
    run: () =>
      withMockGitHub('mock GraphQL deployment lookup', async context => {
        seedDeployment(context.state, ACCEPTANCE_SHAS.oldDeployment)
        seedDeployment(context.state, ACCEPTANCE_SHAS.feature, 'staging')
        requireDeployment(context, 1).statuses.push({
          environment: 'staging',
          environmentUrl: null,
          id: context.state.nextStatusId,
          state: 'failure'
        })
        context.state.nextStatusId += 1

        const result = await requestMockRoute(
          context.port,
          '/graphql',
          'POST',
          {
            query:
              'query($environment:String!){repository{deployments(environments:[$environment]){nodes{id}}}}',
            variables: {environment: 'production'}
          }
        )

        assert.equal(result.status, 200, diagnostics(context))
        assert.equal(
          result.body.includes(ACCEPTANCE_SHAS.oldDeployment),
          true,
          diagnostics(context)
        )

        const inactiveResult = await requestMockRoute(
          context.port,
          '/graphql',
          'POST',
          {
            query:
              'query($environment:String!){repository{deployments(environments:[$environment]){nodes{state}}}}',
            variables: {environment: 'staging'}
          }
        )
        assert.equal(inactiveResult.status, 200, diagnostics(context))
        assert.equal(
          inactiveResult.body.includes('"state":"INACTIVE"'),
          true,
          diagnostics(context)
        )

        const defaultEnvironmentResult = await requestMockRoute(
          context.port,
          '/graphql',
          'POST',
          {
            query:
              'query{repository{deployments(environments:[$environment]){nodes{id}}}}'
          }
        )
        assert.equal(defaultEnvironmentResult.status, 200, diagnostics(context))
        assert.equal(
          defaultEnvironmentResult.body.includes(ACCEPTANCE_SHAS.oldDeployment),
          true,
          diagnostics(context)
        )
      })
  },
  {
    name: 'mock server platform helpers',
    run: () => {
      assert.equal(
        mockServerPort({address: '127.0.0.1', family: 'IPv4', port: 1234}),
        1234
      )
      assert.throws(() => mockServerPort(null), /did not bind/u)
      assert.throws(() => mockServerPort('pipe'), /did not bind/u)
      assert.equal(mockServerCloseAction(undefined), 'resolve')
      assert.equal(mockServerCloseAction(new Error('close failed')), 'reject')
      assert.equal(mockErrorMessage(new Error('message')), 'message')
      assert.equal(mockErrorMessage('string failure'), 'string failure')
      return Promise.resolve()
    }
  },
  {
    name: 'mock server strict request validation',
    run: () =>
      withMockGitHub('mock server strict request validation', async context => {
        seedDeployment(context.state, ACCEPTANCE_SHAS.oldDeployment)
        const deployment = requireDeployment(context)
        context.state.comments.splice(0, context.state.comments.length)
        setTriggerComment(context.state, '.deploy')
        context.state.labels.add('deploying')
        const route = (path: string): string =>
          `/repos/${ACCEPTANCE_REPOSITORY.owner}/${ACCEPTANCE_REPOSITORY.repo}${path}`

        const malformedGraphql = await requestMockRoute(
          context.port,
          '/graphql',
          'POST',
          {variables: {}}
        )
        assert.equal(malformedGraphql.status, 500, diagnostics(context))
        assert.equal(
          malformedGraphql.body.includes('expected string field: query'),
          true,
          diagnostics(context)
        )

        const nonObjectJson = await requestMockRoute(
          context.port,
          '/graphql',
          'POST',
          '[]'
        )
        assert.equal(nonObjectJson.status, 500, diagnostics(context))
        assert.equal(
          nonObjectJson.body.includes('expected JSON object request body'),
          true,
          diagnostics(context)
        )

        const unknownGraphql = await requestMockRoute(
          context.port,
          '/graphql',
          'POST',
          {query: 'query{viewer{login}}'}
        )
        assert.equal(unknownGraphql.status, 500, diagnostics(context))
        assert.equal(
          unknownGraphql.body.includes('Unhandled mock GitHub route'),
          true,
          diagnostics(context)
        )

        const missingPart = await getMockRoute(context.port, '/repos')
        assert.equal(missingPart.status, 500, diagnostics(context))
        assert.equal(
          missingPart.body.includes('missing path segment 1'),
          true,
          diagnostics(context)
        )

        const wrongRepository = await getMockRoute(
          context.port,
          '/repos/Other/actions-sandbox'
        )
        assert.equal(wrongRepository.status, 500, diagnostics(context))
        assert.equal(
          wrongRepository.body.includes('Unhandled mock GitHub route'),
          true,
          diagnostics(context)
        )

        const unknownArea = await getMockRoute(
          context.port,
          route('/unexpected')
        )
        assert.equal(unknownArea.status, 500, diagnostics(context))
        assert.equal(
          unknownArea.body.includes('Unhandled mock GitHub route'),
          true,
          diagnostics(context)
        )

        const missingCommit = await getMockRoute(
          context.port,
          route('/commits/missing')
        )
        assert.equal(missingCommit.status, 404, diagnostics(context))

        const defaultContentRef = await getMockRoute(
          context.port,
          route('/contents/lock.json')
        )
        assert.equal(defaultContentRef.status, 404, diagnostics(context))

        const missingComment = await requestMockRoute(
          context.port,
          route('/issues/comments/999'),
          'PATCH',
          {body: 'missing'}
        )
        assert.equal(missingComment.status, 404, diagnostics(context))
        assert.equal(
          missingComment.body.includes('Comment not found'),
          true,
          diagnostics(context)
        )

        const invalidLabelPayload = await requestMockRoute(
          context.port,
          route('/issues/1/labels'),
          'POST',
          {labels: [1]}
        )
        assert.equal(invalidLabelPayload.status, 500, diagnostics(context))
        assert.equal(
          invalidLabelPayload.body.includes('expected string array field'),
          true,
          diagnostics(context)
        )

        const listedLabels = await getMockRoute(
          context.port,
          route('/issues/1/labels')
        )
        assert.equal(listedLabels.status, 200, diagnostics(context))
        assert.equal(
          listedLabels.body.includes('deploying'),
          true,
          diagnostics(context)
        )

        const deletedLabel = await requestMockRoute(
          context.port,
          route('/issues/1/labels/deploying'),
          'DELETE'
        )
        assert.equal(deletedLabel.status, 200, diagnostics(context))

        const unknownIssueRoute = await getMockRoute(
          context.port,
          route('/issues/1/milestones')
        )
        assert.equal(unknownIssueRoute.status, 500, diagnostics(context))

        const invalidTree = await requestMockRoute(
          context.port,
          route('/git/trees'),
          'POST',
          {tree: []}
        )
        assert.equal(invalidTree.status, 500, diagnostics(context))
        assert.equal(
          invalidTree.body.includes('expected tree item'),
          true,
          diagnostics(context)
        )

        const duplicateRef = await requestMockRoute(
          context.port,
          route('/git/refs'),
          'POST',
          {ref: 'refs/heads/main', sha: ACCEPTANCE_SHAS.default}
        )
        assert.equal(duplicateRef.status, 422, diagnostics(context))

        const directRef = await requestMockRoute(
          context.port,
          route('/git/refs'),
          'POST',
          {ref: 'refs/heads/direct-ref', sha: ACCEPTANCE_SHAS.default}
        )
        assert.equal(directRef.status, 201, diagnostics(context))

        const missingRef = await requestMockRoute(
          context.port,
          route('/git/refs/heads/missing'),
          'DELETE'
        )
        assert.equal(missingRef.status, 422, diagnostics(context))

        const unknownGitRoute = await getMockRoute(
          context.port,
          route('/git/unexpected')
        )
        assert.equal(unknownGitRoute.status, 500, diagnostics(context))

        const invalidStatus = await requestMockRoute(
          context.port,
          route(`/deployments/${deployment.id}/statuses`),
          'POST',
          {environment: 'production', environment_url: 1, state: 'success'}
        )
        assert.equal(invalidStatus.status, 500, diagnostics(context))
        assert.equal(
          invalidStatus.body.includes('expected optional string field'),
          true,
          diagnostics(context)
        )

        const unknownDeployment = await requestMockRoute(
          context.port,
          route('/deployments/999/statuses'),
          'POST',
          {environment: 'production', state: 'success'}
        )
        assert.equal(unknownDeployment.status, 500, diagnostics(context))
        assert.equal(
          unknownDeployment.body.includes('unknown deployment id'),
          true,
          diagnostics(context)
        )

        const unknownDeploymentRoute = await getMockRoute(
          context.port,
          route('/deployments/999')
        )
        assert.equal(unknownDeploymentRoute.status, 500, diagnostics(context))
      })
  },
  {
    name: 'runner missing trigger diagnostics',
    run: () =>
      withMockGitHub('runner missing trigger diagnostics', async context => {
        context.state.comments.splice(0, context.state.comments.length)
        await assert.rejects(() => runMain(context), /missing trigger comment/u)
      })
  },
  {
    name: 'scenario failure diagnostics',
    run: async () => {
      await assert.rejects(
        () =>
          withMockGitHub('scenario failure diagnostics', () =>
            Promise.reject(new Error('intentional diagnostics failure'))
          ),
        /scenario failure diagnostics failed/u
      )
    }
  },
  {
    name: 'unknown mock route',
    run: () =>
      withMockGitHub('unknown mock route', async context => {
        const result = await getMockRoute(context.port, '/not-handled')

        assert.equal(result.status, 500, diagnostics(context))
        assert.equal(
          result.body.includes('Unhandled mock GitHub route'),
          true,
          diagnostics(context)
        )
      })
  }
] satisfies readonly Scenario[]

for (const scenario of scenarios) {
  await scenario.run()
  process.stdout.write(`ok - ${scenario.name}\n`)
}

process.stdout.write(`acceptance: ${scenarios.length} scenarios passed\n`)
