import assert from 'node:assert/strict'
import {
  ACCEPTANCE_REPOSITORY,
  ACCEPTANCE_SHAS,
  createMockState,
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
    reactions: state.reactions.map(reaction => ({
      commentId: reaction.commentId,
      content: reaction.content,
      id: reaction.id
    }))
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
  assert.notStrictEqual(value, undefined, diagnostics(context, result))
  return value ?? ''
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

function requireDeployment(
  context: ScenarioContext,
  index = 0
): MockDeployment {
  const deployment = context.state.deployments[index]
  assert.notStrictEqual(deployment, undefined, diagnostics(context))
  if (deployment === undefined) {
    throw new Error('deployment unexpectedly missing')
  }
  return deployment
}

function requireDeploymentStatus(
  context: ScenarioContext,
  deployment: MockDeployment,
  index: number
): MockDeploymentStatus {
  const status = deployment.statuses[index]
  assert.notStrictEqual(status, undefined, diagnostics(context))
  if (status === undefined) {
    throw new Error('deployment status unexpectedly missing')
  }
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
    const detail = error instanceof Error ? error.stack : String(error)
    throw new Error(
      `${name} failed\n${String(detail)}\n${diagnostics(context)}`
    )
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
    state: context.state
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
  return fetch(`http://127.0.0.1:${port}${path}`).then(async response => ({
    body: await response.text(),
    status: response.status
  }))
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
