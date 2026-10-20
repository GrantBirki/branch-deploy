import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import {load} from 'js-yaml'

function example(heading: string): unknown {
  const examples = readFileSync('docs/examples.md', 'utf8').split('\n## ')
  const section = examples.find(part => part.startsWith(heading + '\n')) ?? ''
  const yaml = /```yaml\n([\s\S]*?)\n```/u.exec(section)?.[1]
  assert.ok(yaml !== undefined, `missing ${heading} workflow`)
  return load(yaml)
}

for (const provider of ['Heroku', 'Railway']) {
  test(`${provider} publishes only when continue is true and noop is false`, () => {
    const outputs = 'steps.branch-deploy.outputs.'
    const deployOnly =
      outputs + "continue == 'true' && " + outputs + "noop == 'false'"
    const names = ['Checkout']
    if (provider === 'Railway') names.push('Install Railway')
    names.push(`Deploy to ${provider}`)

    assert.partialDeepStrictEqual(example(provider), {
      jobs: {
        deploy: {steps: names.map(name => ({name, if: deployOnly}))}
      }
    })
  })
}

function expression(...lines: readonly string[]): string {
  return '${{ ' + lines.join('\n    ') + ' }}'
}

function assertRecord(
  value: unknown
): asserts value is Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value)
  )
}

for (const site of ['Hugo', 'Astro']) {
  test(`${site} builds an admitted noop and includes every required job's result`, () => {
    const outputs = 'needs.trigger.outputs.'
    const admitted = outputs + "continue == 'true'"
    const noop = outputs + 'noop'
    const sameAttempt =
      'fromJSON(needs.trigger.outputs.context).run_attempt == github.run_attempt'
    const workflow = example(`Multiple Jobs with GitHub Pages and ${site}`)
    assertRecord(workflow)
    const jobs = workflow['jobs']
    assertRecord(jobs)
    const build = jobs['build']
    assertRecord(build)
    assert.deepStrictEqual(
      build['permissions'],
      site === 'Hugo' ? {contents: 'read', pages: 'read'} : {contents: 'read'}
    )
    assert.partialDeepStrictEqual(workflow, {
      'cache-mode': 'none',
      jobs: {
        build: {
          needs: 'trigger',
          if: expression(`${admitted} &&`, sameAttempt),
          steps: [
            {
              uses: 'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9',
              if: expression(`${noop} == 'false'`),
              with: {path: site === 'Hugo' ? './public' : './dist'}
            }
          ]
        },
        deploy: {
          needs: ['trigger', 'build'],
          if: expression(
            `${admitted} &&`,
            `${noop} == 'false' &&`,
            sameAttempt
          ),
          permissions: {pages: 'write', 'id-token': 'write'},
          steps: [
            {
              uses: 'actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346'
            }
          ]
        },
        result: {
          needs: ['trigger', 'build', 'deploy'],
          if: expression(`always() && ${admitted}`),
          steps: [
            {
              with: {
                result_mode: true,
                context: '${{ needs.trigger.outputs.context }}',
                job_results: expression(
                  `${noop} == 'true' &&`,
                  `format('["{0}"]', needs.build.result) ||`,
                  `format('["{0}","{1}"]', needs.build.result, needs.deploy.result)`
                )
              }
            }
          ]
        }
      }
    })
  })
}
