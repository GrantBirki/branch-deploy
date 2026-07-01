import {Buffer} from 'node:buffer'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type {
  MockBranch,
  MockCommit,
  MockDeployment,
  MockDeploymentStatus,
  MockGitHubState,
  MockReaction,
  MockRollupContext,
  MockRouteLog
} from './types.ts'

export const ACCEPTANCE_REPOSITORY = {
  owner: 'GrantBirki',
  repo: 'actions-sandbox'
} as const

export const ACCEPTANCE_SHAS = {
  default: '1111111111111111111111111111111111111111',
  feature: '2222222222222222222222222222222222222222',
  fork: '3333333333333333333333333333333333333333',
  oldDeployment: '4444444444444444444444444444444444444444'
} as const

const owner = ACCEPTANCE_REPOSITORY.owner
const repo = ACCEPTANCE_REPOSITORY.repo
const defaultBranch = 'main'
const defaultSha = ACCEPTANCE_SHAS.default
const featureSha = ACCEPTANCE_SHAS.feature
const forkSha = ACCEPTANCE_SHAS.fork
const oldDeploymentSha = ACCEPTANCE_SHAS.oldDeployment
const treeSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const oldTreeSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const commitDate = '2026-01-01T00:00:00Z'

interface MockServer {
  readonly close: () => Promise<void>
  readonly port: number
  readonly routeLog: readonly MockRouteLog[]
}

interface JsonResponse {
  readonly headers?: Readonly<Record<string, string>>
  readonly status: number
  readonly value?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new Error(`expected string field: ${key}`)
  }
  return value
}

function optionalString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`expected optional string field: ${key}`)
  }
  return value
}

function requireStringArray(
  record: Record<string, unknown>,
  key: string
): readonly string[] {
  const value = record[key]
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`expected string array field: ${key}`)
  }
  return value
}

function part(parts: readonly string[], index: number): string {
  const value = parts[index]
  if (value === undefined) {
    throw new Error(`missing path segment ${index}`)
  }
  return decodeURIComponent(value)
}

function shaFor(id: number): string {
  return id.toString(16).padStart(40, '0')
}

function createBranch(name: string, sha: string): MockBranch {
  return {name, sha, treeSha}
}

function createCommit(
  sha: string,
  verified: boolean,
  commitTreeSha = treeSha
): MockCommit {
  return {
    date: commitDate,
    htmlUrl: `https://github.com/${owner}/${repo}/commit/${sha}`,
    sha,
    treeSha: commitTreeSha,
    verified,
    verifiedAt: verified ? commitDate : null,
    verificationReason: verified ? 'valid' : 'unsigned'
  }
}

export function createMockState(): MockGitHubState {
  lockFiles.clear()
  blobs.clear()
  trees.clear()
  commitsToTrees.clear()

  const branches = new Map<string, MockBranch>()
  branches.set(defaultBranch, createBranch(defaultBranch, defaultSha))
  branches.set('feature-branch', createBranch('feature-branch', featureSha))
  branches.set('fork-branch', createBranch('fork-branch', forkSha))

  const commits = new Map<string, MockCommit>()
  commits.set(defaultSha, createCommit(defaultSha, true))
  commits.set(featureSha, createCommit(featureSha, true))
  commits.set(forkSha, createCommit(forkSha, true))
  commits.set(
    oldDeploymentSha,
    createCommit(oldDeploymentSha, true, oldTreeSha)
  )

  return {
    branchRules: [],
    branches,
    comments: [
      {
        body: '.deploy',
        id: 1000
      }
    ],
    commits,
    comparisonBehindBy: 0,
    confirmationReaction: null,
    deployments: [],
    failInitialReaction: false,
    graphqlCommitOid: null,
    labels: new Set(),
    mergeStateStatus: 'CLEAN',
    nextCommentId: 2000,
    nextDeploymentId: 3000,
    nextGitId: 4000,
    nextReactionId: 5000,
    nextStatusId: 6000,
    owner,
    permission: 'write',
    pullRequest: {
      baseRef: defaultBranch,
      draft: false,
      headLabel: `${owner}:feature-branch`,
      headRef: 'feature-branch',
      headRepoFork: false,
      headRepoFullName: `${owner}/${repo}`,
      headSha: featureSha,
      merged: true,
      number: 1
    },
    reactionFailureConsumed: false,
    reactions: [],
    repo,
    repositoryDefaultBranch: defaultBranch,
    reviewDecision: 'APPROVED',
    rollupAvailable: true,
    rollupContexts: [
      {
        conclusion: 'SUCCESS',
        isRequired: true,
        name: 'acceptance',
        type: 'check-run'
      }
    ],
    rollupState: 'SUCCESS'
  }
}

export function setTriggerComment(state: MockGitHubState, body: string): void {
  const existing = state.comments[0]
  const id = existing === undefined ? 1000 : existing.id
  state.comments[0] = {body, id}
}

export function seedLock(
  state: MockGitHubState,
  environment: string,
  branch: string,
  createdBy: string,
  pullRequestNumber: number
): void {
  const branchName = `${environment}-branch-deploy-lock`
  const lock = {
    schema_version: 1,
    reason: 'deployment',
    branch,
    created_at: '2026-01-01T00:00:00.000Z',
    created_by: createdBy,
    sticky: true,
    environment,
    global: false,
    unlock_command: `.unlock ${environment}`,
    link: `https://github.com/${state.owner}/${state.repo}/pull/${pullRequestNumber}#issuecomment-1000`,
    claim_id:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  }
  const branchShaValue = shaFor(state.nextGitId)
  state.branches.set(branchName, createBranch(branchName, branchShaValue))
  state.nextGitId += 1
  state.commits.set(branchShaValue, createCommit(branchShaValue, true))
  state.comments.push({body: JSON.stringify(lock), id: state.nextCommentId})
  state.nextCommentId += 1
  lockFiles.set(lockFileKey(state, branchName), JSON.stringify(lock))
}

const lockFiles = new Map<string, string>()

function lockFileKey(state: MockGitHubState, branch: string): string {
  return `${state.owner}/${state.repo}/${branch}/lock.json`
}

function branchSha(state: MockGitHubState, ref: string): string {
  const branch = state.branches.get(ref)
  return branch === undefined ? ref : branch.sha
}

function branchResponse(branch: MockBranch): unknown {
  return {
    name: branch.name,
    commit: {
      sha: branch.sha,
      commit: {
        tree: {
          sha: branch.treeSha
        }
      }
    }
  }
}

function commitResponse(commit: MockCommit): unknown {
  return {
    sha: commit.sha,
    html_url: commit.htmlUrl,
    commit: {
      author: {
        date: commit.date
      },
      tree: {
        sha: commit.treeSha
      },
      verification: {
        reason: commit.verificationReason,
        verified: commit.verified,
        verified_at: commit.verifiedAt
      }
    }
  }
}

function pullResponse(state: MockGitHubState): unknown {
  const pr = state.pullRequest
  return {
    number: pr.number,
    draft: pr.draft,
    merged: pr.merged,
    base: {
      ref: pr.baseRef
    },
    head: {
      label: pr.headLabel,
      ref: pr.headRef,
      sha: pr.headSha,
      repo: {
        fork: pr.headRepoFork,
        full_name: pr.headRepoFullName
      }
    }
  }
}

function checkRollup(state: MockGitHubState): unknown {
  if (!state.rollupAvailable) {
    return undefined
  }
  if (state.rollupState === null) {
    return null
  }
  return {
    state: state.rollupState,
    contexts: {
      nodes: state.rollupContexts.map(rollupContextResponse),
      pageInfo: {
        endCursor: null,
        hasNextPage: false
      }
    }
  }
}

function rollupContextResponse(context: MockRollupContext): unknown {
  if (context.type === 'check-run') {
    return {
      __typename: 'CheckRun',
      conclusion: context.conclusion,
      isRequired: context.isRequired,
      name: context.name
    }
  }
  return {
    __typename: 'StatusContext',
    context: context.context,
    isRequired: context.isRequired,
    state: context.state
  }
}

function prechecksGraphql(state: MockGitHubState): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewDecision: state.reviewDecision,
          mergeStateStatus: state.mergeStateStatus,
          reviews: {
            totalCount: state.reviewDecision === 'APPROVED' ? 1 : 0
          },
          commits: {
            nodes: [
              {
                commit: {
                  id: 'C_acceptance',
                  oid: state.graphqlCommitOid ?? state.pullRequest.headSha,
                  statusCheckRollup: checkRollup(state)
                }
              }
            ]
          }
        }
      }
    }
  }
}

function deploymentGraphql(
  state: MockGitHubState,
  environment: string
): unknown {
  const nodes = state.deployments
    .filter(deployment => deployment.environment === environment)
    .map(deployment => {
      const latestStatus = deployment.statuses.at(-1)
      return {
        createdAt: deployment.createdAt,
        environment: deployment.environment,
        updatedAt: deployment.updatedAt,
        id: `D_${deployment.id}`,
        payload: JSON.stringify(deployment.payload),
        state: latestStatus?.state === 'success' ? 'ACTIVE' : 'INACTIVE',
        ref: {
          name: deployment.ref
        },
        creator: {
          login: 'github-actions'
        },
        commit: {
          oid: deployment.sha
        }
      }
    })
  return {
    data: {
      repository: {
        deployments: {
          nodes,
          pageInfo: {
            endCursor: null,
            hasNextPage: false
          }
        }
      }
    }
  }
}

function routeGraphql(
  state: MockGitHubState,
  body: Record<string, unknown>
): JsonResponse {
  const query = requireString(body, 'query')
  const variables = isRecord(body['variables']) ? body['variables'] : {}
  if (query.includes('pullRequest(number:$number)')) {
    return {status: 200, value: prechecksGraphql(state)}
  }
  if (query.includes('deployments(environments:')) {
    const environment =
      typeof variables['environment'] === 'string'
        ? variables['environment']
        : 'production'
    return {status: 200, value: deploymentGraphql(state, environment)}
  }
  return unknownRoute('POST', '/graphql')
}

function createReaction(
  state: MockGitHubState,
  commentId: number,
  content: string
): MockReaction {
  const reaction = {
    commentId,
    content,
    id: state.nextReactionId,
    user: 'GrantBirki'
  }
  state.nextReactionId += 1
  state.reactions.push(reaction)
  return reaction
}

function issueCommentReactionResponse(reaction: MockReaction): unknown {
  return {
    id: reaction.id,
    content: reaction.content,
    user: {
      login: reaction.user
    }
  }
}

function createDeployment(
  state: MockGitHubState,
  body: Record<string, unknown>
): MockDeployment {
  const ref = requireString(body, 'ref')
  const environment = requireString(body, 'environment')
  const deployment = {
    createdAt: '2026-01-01T00:20:00Z',
    environment,
    id: state.nextDeploymentId,
    payload: body['payload'],
    ref,
    sha: branchSha(state, ref),
    statuses: [],
    updatedAt: '2026-01-01T00:20:00Z'
  }
  state.nextDeploymentId += 1
  state.deployments.push(deployment)
  return deployment
}

function deploymentResponse(
  state: MockGitHubState,
  deployment: MockDeployment
) {
  return {
    id: deployment.id,
    url: `http://127.0.0.1/repos/${state.owner}/${state.repo}/deployments/${deployment.id}`,
    created_at: deployment.createdAt,
    updated_at: deployment.updatedAt,
    statuses_url: `http://127.0.0.1/repos/${state.owner}/${state.repo}/deployments/${deployment.id}/statuses`
  }
}

function createDeploymentStatus(
  state: MockGitHubState,
  deploymentId: number,
  body: Record<string, unknown>
): MockDeploymentStatus {
  const deployment = state.deployments.find(item => item.id === deploymentId)
  if (deployment === undefined) {
    throw new Error(`unknown deployment id: ${deploymentId}`)
  }
  const status = {
    environment: requireString(body, 'environment'),
    environmentUrl: optionalString(body, 'environment_url') ?? null,
    id: state.nextStatusId,
    state: requireString(body, 'state')
  }
  state.nextStatusId += 1
  deployment.statuses.push(status)
  return status
}

function statusResponse(status: MockDeploymentStatus): unknown {
  return {
    id: status.id,
    url: `http://127.0.0.1/deployment-status/${status.id}`
  }
}

function createGitObjectSha(state: MockGitHubState): string {
  const sha = shaFor(state.nextGitId)
  state.nextGitId += 1
  return sha
}

const blobs = new Map<string, string>()
const trees = new Map<string, string>()
const commitsToTrees = new Map<string, string>()

function routeRest(
  state: MockGitHubState,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  body: Record<string, unknown>
): JsonResponse {
  const parts = pathname.split('/').filter(value => value !== '')
  if (part(parts, 0) !== 'repos') {
    return unknownRoute(method, pathname)
  }
  const requestOwner = part(parts, 1)
  const requestRepo = part(parts, 2)
  if (requestOwner !== state.owner || requestRepo !== state.repo) {
    return unknownRoute(method, pathname)
  }

  if (method === 'GET' && parts.length === 3) {
    return {status: 200, value: {default_branch: state.repositoryDefaultBranch}}
  }

  const area = part(parts, 3)

  if (area === 'collaborators' && method === 'GET') {
    return {status: 200, value: {permission: state.permission}}
  }

  if (
    area === 'pulls' &&
    method === 'PUT' &&
    part(parts, 5) === 'update-branch'
  ) {
    return {status: 202, value: {}}
  }

  if (area === 'pulls' && method === 'GET' && parts.length === 5) {
    return {status: 200, value: pullResponse(state)}
  }

  if (area === 'branches' && method === 'GET') {
    const branch = state.branches.get(part(parts, 4))
    return branch === undefined
      ? notFound('Branch not found')
      : {status: 200, value: branchResponse(branch)}
  }

  if (area === 'rules' && method === 'GET') {
    return {status: 200, value: state.branchRules}
  }

  if (area === 'compare' && method === 'GET') {
    return {status: 200, value: {behind_by: state.comparisonBehindBy}}
  }

  if (area === 'commits' && method === 'GET') {
    const commit = state.commits.get(part(parts, 4))
    return commit === undefined
      ? notFound('Commit not found')
      : {status: 200, value: commitResponse(commit)}
  }

  if (area === 'contents' && method === 'GET') {
    const ref = searchParams.get('ref') ?? state.repositoryDefaultBranch
    const path = parts.slice(4).map(decodeURIComponent).join('/')
    const content = lockFiles.get(`${state.owner}/${state.repo}/${ref}/${path}`)
    return content === undefined
      ? notFound('Not Found')
      : {
          status: 200,
          value: {
            content: Buffer.from(content).toString('base64'),
            encoding: 'base64',
            path
          }
        }
  }

  if (area === 'issues') {
    return routeIssues(state, method, parts, body)
  }

  if (area === 'git') {
    return routeGit(state, method, parts, body)
  }

  if (area === 'deployments') {
    return routeDeployments(state, method, parts, body, searchParams)
  }

  return unknownRoute(method, pathname)
}

function routeIssues(
  state: MockGitHubState,
  method: string,
  parts: readonly string[],
  body: Record<string, unknown>
): JsonResponse {
  if (method === 'POST' && part(parts, 5) === 'comments') {
    const comment = {
      body: requireString(body, 'body'),
      id: state.nextCommentId
    }
    state.nextCommentId += 1
    state.comments.push(comment)
    return {status: 201, value: {id: comment.id, body: comment.body}}
  }

  if (part(parts, 4) === 'comments') {
    const commentId = Number(part(parts, 5))
    if (method === 'PATCH') {
      const comment = state.comments.find(item => item.id === commentId)
      if (comment === undefined) {
        return notFound('Comment not found')
      }
      const updated = {body: requireString(body, 'body'), id: comment.id}
      state.comments.splice(state.comments.indexOf(comment), 1, updated)
      return {status: 200, value: {id: updated.id, body: updated.body}}
    }
    if (part(parts, 6) === 'reactions') {
      if (method === 'POST') {
        if (state.failInitialReaction && !state.reactionFailureConsumed) {
          state.reactionFailureConsumed = true
          return {status: 500, value: {message: 'reaction unavailable'}}
        }
        const reaction = createReaction(
          state,
          commentId,
          requireString(body, 'content')
        )
        return {status: 201, value: issueCommentReactionResponse(reaction)}
      }
      if (method === 'GET') {
        const existing = state.reactions.filter(
          reaction => reaction.commentId === commentId
        )
        if (state.confirmationReaction !== null && existing.length === 0) {
          const reaction = createReaction(
            state,
            commentId,
            state.confirmationReaction
          )
          return {
            status: 200,
            value: [issueCommentReactionResponse(reaction)]
          }
        }
        return {
          status: 200,
          value: existing.map(issueCommentReactionResponse)
        }
      }
      if (method === 'DELETE') {
        const reactionId = Number(part(parts, 7))
        const index = state.reactions.findIndex(
          reaction => reaction.id === reactionId
        )
        if (index >= 0) {
          state.reactions.splice(index, 1)
        }
        return {status: 204}
      }
    }
  }

  if (part(parts, 5) === 'labels') {
    if (method === 'GET') {
      return {
        status: 200,
        value: [...state.labels].map(name => ({name}))
      }
    }
    if (method === 'POST') {
      for (const label of requireStringArray(body, 'labels')) {
        state.labels.add(label)
      }
      return {
        status: 200,
        value: [...state.labels].map(name => ({name}))
      }
    }
    if (method === 'DELETE') {
      state.labels.delete(part(parts, 6))
      return {status: 200, value: {}}
    }
  }

  return unknownRoute(method, `/${parts.join('/')}`)
}

function routeGit(
  state: MockGitHubState,
  method: string,
  parts: readonly string[],
  body: Record<string, unknown>
): JsonResponse {
  const resource = part(parts, 4)
  if (method === 'POST' && resource === 'blobs') {
    const sha = createGitObjectSha(state)
    blobs.set(sha, requireString(body, 'content'))
    return {status: 201, value: {sha}}
  }
  if (method === 'POST' && resource === 'trees') {
    const treeItems = body['tree']
    if (!Array.isArray(treeItems) || !isRecord(treeItems[0])) {
      throw new Error('expected tree item')
    }
    const sha = requireString(treeItems[0], 'sha')
    const treeShaValue = createGitObjectSha(state)
    trees.set(treeShaValue, sha)
    return {status: 201, value: {sha: treeShaValue}}
  }
  if (method === 'POST' && resource === 'commits') {
    const commitSha = createGitObjectSha(state)
    const treeShaValue = requireString(body, 'tree')
    commitsToTrees.set(commitSha, treeShaValue)
    state.commits.set(commitSha, createCommit(commitSha, true))
    return {status: 201, value: {sha: commitSha}}
  }
  if (method === 'POST' && resource === 'refs') {
    const ref = requireString(body, 'ref').replace('refs/heads/', '')
    const sha = requireString(body, 'sha')
    if (state.branches.has(ref)) {
      return {status: 422, value: {message: 'Reference already exists'}}
    }
    state.branches.set(ref, createBranch(ref, sha))
    const treeShaValue = commitsToTrees.get(sha)
    const blobSha =
      treeShaValue === undefined ? undefined : trees.get(treeShaValue)
    const content = blobSha === undefined ? undefined : blobs.get(blobSha)
    if (content !== undefined) {
      lockFiles.set(lockFileKey(state, ref), content)
    }
    return {status: 201, value: {ref: `refs/heads/${ref}`, object: {sha}}}
  }
  if (method === 'DELETE' && resource === 'refs') {
    const ref = parts
      .slice(5)
      .map(decodeURIComponent)
      .join('/')
      .replace('heads/', '')
    if (!state.branches.has(ref)) {
      return {status: 422, value: {message: 'Reference does not exist'}}
    }
    state.branches.delete(ref)
    lockFiles.delete(lockFileKey(state, ref))
    return {status: 204}
  }
  return unknownRoute(method, `/${parts.join('/')}`)
}

function routeDeployments(
  state: MockGitHubState,
  method: string,
  parts: readonly string[],
  body: Record<string, unknown>,
  searchParams: URLSearchParams
): JsonResponse {
  if (method === 'GET' && parts.length === 4) {
    const environment = searchParams.get('environment')
    const deployments = state.deployments.filter(
      deployment =>
        environment === null || deployment.environment === environment
    )
    return {
      status: 200,
      value: deployments.map(deployment => ({
        id: deployment.id,
        sha: deployment.sha,
        payload: deployment.payload,
        created_at: deployment.createdAt
      }))
    }
  }
  if (method === 'POST' && parts.length === 4) {
    const deployment = createDeployment(state, body)
    return {status: 201, value: deploymentResponse(state, deployment)}
  }
  if (method === 'POST' && part(parts, 5) === 'statuses') {
    const deploymentId = Number(part(parts, 4))
    const status = createDeploymentStatus(state, deploymentId, body)
    return {status: 201, value: statusResponse(status)}
  }
  return unknownRoute(method, `/${parts.join('/')}`)
}

function notFound(message: string): JsonResponse {
  return {status: 404, value: {message}}
}

function unknownRoute(method: string, path: string): JsonResponse {
  return {
    status: 500,
    value: {message: `Unhandled mock GitHub route: ${method} ${path}`}
  }
}

function parseJson(source: string): Record<string, unknown> {
  if (source === '') {
    return {}
  }
  const parsed: unknown = JSON.parse(source)
  if (!isRecord(parsed)) {
    throw new Error('expected JSON object request body')
  }
  return parsed
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.from(chunk))
    })
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', reject)
  })
}

function writeResponse(response: ServerResponse, result: JsonResponse): void {
  response.statusCode = result.status
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    response.setHeader(name, value)
  }
  if (result.value === undefined) {
    response.end()
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(result.value))
}

export async function startMockGitHub(
  state: MockGitHubState
): Promise<MockServer> {
  const routeLog: MockRouteLog[] = []
  const server = createServer((request, response) => {
    void handleRequest(state, routeLog, request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve)
    server.on('error', reject)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('mock server did not bind to a TCP port')
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      }),
    port: address.port,
    routeLog
  }
}

async function handleRequest(
  state: MockGitHubState,
  routeLog: MockRouteLog[],
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const rawBody = await readBody(request)
  routeLog.push({body: rawBody, method, path: url.pathname})
  try {
    const body = parseJson(rawBody)
    const result =
      url.pathname === '/graphql'
        ? routeGraphql(state, body)
        : routeRest(state, method, url.pathname, url.searchParams, body)
    writeResponse(response, result)
  } catch (error) {
    writeResponse(response, {
      status: 500,
      value: {
        message: error instanceof Error ? error.message : String(error)
      }
    })
  }
}
