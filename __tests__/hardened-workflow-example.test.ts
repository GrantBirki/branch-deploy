import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const BRANCH_DEPLOY_V12_1_0 = 'a7a7ea40a15a79a036322c2924ab74f5eded702c'
const CHECKOUT_V7_0_0 = '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0'

function hardenedSection(): string {
  const examples = readFileSync('docs/examples.md', 'utf8')
  const section =
    /^## Hardened Workflow Starting Point\n([\s\S]*?)(?=^## )/mu.exec(
      examples
    )?.[1]
  assert.ok(section !== undefined)
  return section
}

function hardenedWorkflow(): string {
  const section = hardenedSection()
  const workflow = /```yaml\n([\s\S]*?)\n```/u.exec(section)?.[1]
  assert.ok(workflow !== undefined)
  return workflow
}

function job(workflow: string, name: string): string {
  const marker = `  ${name}:\n`
  const start = workflow.indexOf(marker)
  assert.notStrictEqual(start, -1)
  const bodyStart = start + marker.length
  const remaining = workflow.slice(bodyStart)
  const nextJob = /^  [a-z][a-z-]*:\n/mu.exec(remaining)
  return remaining.slice(0, nextJob?.index ?? remaining.length)
}

test('the hardened starting point admits only owner and member comments by default', () => {
  const section = hardenedSection()
  const branchDeploy = job(hardenedWorkflow(), 'branch-deploy')

  assert.match(branchDeploy, /github\.event\.issue\.pull_request/u)
  assert.match(
    branchDeploy,
    /contains\(\s*fromJSON\('\["OWNER", "MEMBER"\]'\),\s*github\.event\.comment\.author_association\s*\)/u
  )
  assert.doesNotMatch(branchDeploy, /COLLABORATOR/u)

  assert.match(section, /`COLLABORATOR` is deliberately omitted/u)
  assert.match(
    section,
    /commenter's association with the repository, not the pull request head/u
  )
  assert.match(
    section,
    /secure `allow_forks: false` default remains the fork control/u
  )
  assert.match(section, /repository-permission and request-admission checks/u)
})

test('the hardened starting point uses lowercase names and commented action pins', () => {
  const workflow = hardenedWorkflow()
  const names = Array.from(workflow.matchAll(/^\s*name: (.+)$/gmu), match => {
    const name = match[1]
    assert.ok(name !== undefined)
    return name
  })
  assert.ok(names.length > 0)
  for (const name of names) {
    assert.strictEqual(name, name.toLowerCase())
  }

  const actionUses = Array.from(
    workflow.matchAll(/^\s*uses: (.+)$/gmu),
    match => {
      const actionUse = match[1]
      assert.ok(actionUse !== undefined)
      return actionUse
    }
  )
  assert.strictEqual(actionUses.length, 6)
  for (const actionUse of actionUses) {
    assert.match(actionUse, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u)
  }
})

test('the hardened starting point keeps admission, validation, deployment, and reporting separate', () => {
  const workflow = hardenedWorkflow()
  const branchDeploy = job(workflow, 'branch-deploy')
  const validate = job(workflow, 'validate')
  const deploy = job(workflow, 'deploy')
  const result = job(workflow, 'result')

  assert.doesNotMatch(branchDeploy, /allow_forks:/u)
  assert.match(branchDeploy, /environment_targets: production/u)
  assert.match(branchDeploy, /skip_completing: true/u)
  assert.doesNotMatch(
    branchDeploy,
    /actions\/checkout|environment:|secrets\.|id-token:/u
  )

  assert.match(validate, /needs: branch-deploy/u)
  assert.match(validate, /\.run_attempt == github\.run_attempt/u)
  assert.match(validate, /\.trusted_sha/u)
  assert.match(validate, /ref: \$\{\{ needs\.branch-deploy\.outputs\.sha \}\}/u)
  assert.match(validate, /validate-candidate/u)
  assert.doesNotMatch(
    validate,
    /environment:|secrets\.|id-token:|terraform|setup-|cache|artifact/iu
  )

  assert.match(deploy, /needs: \[branch-deploy, validate\]/u)
  assert.match(deploy, /needs\.branch-deploy\.outputs\.noop != 'true'/u)
  assert.match(deploy, /needs\.validate\.result == 'success'/u)
  assert.match(deploy, /\.run_attempt == github\.run_attempt/u)
  assert.match(deploy, /environment: production/u)
  assert.match(deploy, /\.trusted_sha/u)
  assert.match(deploy, /ref: \$\{\{ needs\.branch-deploy\.outputs\.sha \}\}/u)
  assert.match(deploy, /validate-candidate/u)
  assert.match(deploy, /deploy-candidate/u)
  assert.match(deploy, /DEPLOY_TOKEN: \$\{\{ secrets\.DEPLOY_TOKEN \}\}/u)

  assert.match(result, /needs: \[branch-deploy, validate, deploy\]/u)
  assert.match(result, /result_mode: true/u)
  assert.match(
    result,
    /context: \$\{\{ needs\.branch-deploy\.outputs\.context \}\}/u
  )
  assert.match(result, /needs\.validate\.result/u)
  assert.match(result, /needs\.deploy\.result/u)
  assert.doesNotMatch(result, /actions\/checkout|secrets\.|id-token:/u)

  const branchDeployPins = Array.from(
    workflow.matchAll(/uses: grantbirki\/branch-deploy@([0-9a-f]{40})/gu),
    match => match[1]
  )
  assert.deepStrictEqual(branchDeployPins, [
    BRANCH_DEPLOY_V12_1_0,
    BRANCH_DEPLOY_V12_1_0
  ])

  const checkoutPins = Array.from(
    workflow.matchAll(/uses: actions\/checkout@([0-9a-f]{40})/gu),
    match => match[1]
  )
  assert.deepStrictEqual(checkoutPins, [
    CHECKOUT_V7_0_0,
    CHECKOUT_V7_0_0,
    CHECKOUT_V7_0_0,
    CHECKOUT_V7_0_0
  ])
  assert.strictEqual(
    workflow.match(/persist-credentials: false/gu)?.length,
    checkoutPins.length
  )
  assert.doesNotMatch(
    workflow,
    /actions\/(?:cache|upload-artifact|download-artifact)/u
  )
})
