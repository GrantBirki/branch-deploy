import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

test('noop documentation does not present downstream execution as a sandbox', () => {
  const action = readFileSync('action.yml', 'utf8')
  const readme = readFileSync('README.md', 'utf8')
  const usage = readFileSync('docs/usage.md', 'utf8')
  const boundary = readFileSync('docs/noop-execution-boundary.md', 'utf8')

  assert.match(action, /This is a routing signal for consumer-defined steps/u)
  assert.match(action, /it does not sandbox them/u)

  assert.match(readme, /### Noop is not a sandbox/u)
  assert.match(readme, /before candidate-controlled tools, providers, hooks/u)
  assert.match(readme, /docs\/noop-execution-boundary\.md/u)

  assert.match(usage, /This is not a sandbox/u)
  assert.match(usage, /noop-execution-boundary\.md/u)

  assert.match(boundary, /before candidate tooling, provider installation/u)
  assert.match(boundary, /terraform init -backend=false/u)
  assert.match(boundary, /terraform validate/u)
  assert.match(boundary, /terraform plan/u)
  assert.match(
    boundary,
    /For non-fork pull requests, noop mode does not require PR approval by default/u
  )
  assert.match(boundary, /fail closed or require review/u)
})
