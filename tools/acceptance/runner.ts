import {spawn} from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {load} from 'js-yaml'
import type {
  AcceptanceOutputs,
  AcceptanceRunResult,
  MockGitHubState
} from './types.ts'

export interface RunActionRequest {
  readonly inputs?: Readonly<Record<string, string>>
  readonly mode: 'main' | 'post'
  readonly port: number
  readonly previousState?: AcceptanceOutputs
  readonly state: MockGitHubState
  readonly status?: 'failure' | 'success'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/ /gu, '_').toUpperCase()}`
}

function loadInputDefaults(): Record<string, string> {
  const metadata = requireRecord(
    load(readFileSync('action.yml', 'utf8')),
    'action.yml'
  )
  const inputs = requireRecord(metadata['inputs'], 'action.yml inputs')
  const defaults: Record<string, string> = {}
  for (const [name, value] of Object.entries(inputs)) {
    const definition = requireRecord(value, `input ${name}`)
    const defaultValue = definition['default']
    defaults[name] = typeof defaultValue === 'string' ? defaultValue : ''
  }
  defaults['github_token'] = 'acceptance-token'
  defaults['status'] = 'success'
  return defaults
}

function repositoryPayload(state: MockGitHubState): Record<string, unknown> {
  return {
    default_branch: state.repositoryDefaultBranch,
    full_name: `${state.owner}/${state.repo}`,
    name: state.repo,
    owner: {
      login: state.owner
    }
  }
}

function issueCommentPayload(state: MockGitHubState): Record<string, unknown> {
  const triggerComment = state.comments[0]
  if (triggerComment === undefined) {
    throw new Error('missing trigger comment')
  }
  return {
    action: 'created',
    comment: {
      body: triggerComment.body,
      created_at: '2026-01-01T00:10:00Z',
      html_url: `https://github.com/${state.owner}/${state.repo}/pull/${state.pullRequest.number}#issuecomment-${triggerComment.id}`,
      id: triggerComment.id,
      updated_at: '2026-01-01T00:10:00Z',
      user: {
        login: 'GrantBirki'
      }
    },
    issue: {
      number: state.pullRequest.number,
      pull_request: {
        url: `https://api.github.com/repos/${state.owner}/${state.repo}/pulls/${state.pullRequest.number}`
      }
    },
    repository: repositoryPayload(state)
  }
}

function pullRequestPayload(state: MockGitHubState): Record<string, unknown> {
  return {
    action: 'closed',
    number: state.pullRequest.number,
    pull_request: {
      merged: state.pullRequest.merged,
      number: state.pullRequest.number
    },
    repository: repositoryPayload(state)
  }
}

function eventNameForMode(request: RunActionRequest): string {
  return request.inputs?.['unlock_on_merge_mode'] === 'true'
    ? 'pull_request'
    : 'issue_comment'
}

function eventPayloadForMode(
  request: RunActionRequest
): Record<string, unknown> {
  return eventNameForMode(request) === 'pull_request'
    ? pullRequestPayload(request.state)
    : issueCommentPayload(request.state)
}

function parseCommandFile(path: string): AcceptanceOutputs {
  if (!existsSync(path)) {
    return {}
  }
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u)
  const output: Record<string, string> = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const marker = line.indexOf('<<')
    if (marker < 0) {
      continue
    }
    const key = line.slice(0, marker)
    const delimiter = line.slice(marker + 2)
    const valueLines: string[] = []
    index += 1
    while (index < lines.length && lines[index] !== delimiter) {
      valueLines.push(lines[index] ?? '')
      index += 1
    }
    output[key] = valueLines.join('\n')
  }
  return output
}

function baseEnvironment(
  request: RunActionRequest,
  workspace: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[name] = value
    }
  }

  const defaults = loadInputDefaults()
  const inputs = {...defaults, ...(request.inputs ?? {})}
  inputs['status'] = request.status ?? inputs['status'] ?? 'success'
  for (const [name, value] of Object.entries(inputs)) {
    env[inputEnvName(name)] = value
  }

  const eventName = eventNameForMode(request)
  env['BRANCH_DEPLOY_VITEST_TEST'] = 'true'
  env['CI'] = 'true'
  env['GITHUB_ACTION'] = 'branch-deploy'
  env['GITHUB_ACTIONS'] = 'true'
  env['GITHUB_ACTOR'] = 'GrantBirki'
  env['GITHUB_API_URL'] = `http://127.0.0.1:${request.port}`
  env['GITHUB_EVENT_NAME'] = eventName
  env['GITHUB_EVENT_PATH'] = join(workspace, 'event.json')
  env['GITHUB_GRAPHQL_URL'] = `http://127.0.0.1:${request.port}/graphql`
  env['GITHUB_JOB'] = 'acceptance'
  env['GITHUB_OUTPUT'] = join(workspace, 'output')
  env['GITHUB_REF'] =
    eventName === 'pull_request'
      ? 'refs/heads/main'
      : 'refs/heads/feature-branch'
  env['GITHUB_REPOSITORY'] = `${request.state.owner}/${request.state.repo}`
  env['GITHUB_RUN_ATTEMPT'] = '1'
  env['GITHUB_RUN_ID'] = '123456789'
  env['GITHUB_RUN_NUMBER'] = '1'
  env['GITHUB_SERVER_URL'] = 'https://github.com'
  env['GITHUB_SHA'] = request.state.pullRequest.headSha
  env['GITHUB_STATE'] = join(workspace, 'state')
  env['GITHUB_WORKFLOW'] = 'acceptance'

  if (request.mode === 'post') {
    env['STATE_isPost'] = 'true'
    for (const [name, value] of Object.entries(request.previousState ?? {})) {
      env[`STATE_${name}`] = value
    }
  }

  return env
}

function actionScript(mode: 'main' | 'post'): string {
  if (mode === 'main') {
    return [
      "const action = await import('./dist/index.js')",
      'const result = await action.run()',
      'if (result !== undefined) console.log(`ACCEPTANCE_RESULT:${result}`)'
    ].join(';')
  }
  return "await import('./dist/index.js')"
}

function runNode(
  script: string,
  env: NodeJS.ProcessEnv
): Promise<{
  readonly code: number | null
  readonly stderr: string
  readonly stdout: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        cwd: resolvePath(),
        env
      }
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.from(chunk))
    })
    child.on('error', reject)
    child.on('close', code => {
      resolve({
        code,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8')
      })
    })
  })
}

function resolvePath(): string {
  return resolve('.')
}

export async function runAction(
  request: RunActionRequest
): Promise<AcceptanceRunResult> {
  const workspace = mkdtempSync(join(tmpdir(), 'branch-deploy-acceptance-'))
  const outputPath = join(workspace, 'output')
  const statePath = join(workspace, 'state')
  writeFileSync(
    join(workspace, 'event.json'),
    `${JSON.stringify(eventPayloadForMode(request))}\n`,
    'utf8'
  )
  writeFileSync(outputPath, '', 'utf8')
  writeFileSync(statePath, '', 'utf8')
  const env = baseEnvironment(request, workspace)
  const result = await runNode(actionScript(request.mode), env)
  const output = parseCommandFile(outputPath)
  const state = parseCommandFile(statePath)
  rmSync(workspace, {force: true, recursive: true})
  return {...result, output, state}
}
