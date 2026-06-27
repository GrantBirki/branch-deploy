import {existsSync, readFileSync} from 'node:fs'
import {load} from 'js-yaml'
import {expect, test} from 'vitest'

const releaseWorkflowPath = '.github/workflows/release.yml'
const releaseBuildWorkflowPath = '.github/workflows/release-build.yml'
const releaseCriticalWorkflowPaths = [
  '.github/workflows/package-check.yml',
  releaseBuildWorkflowPath,
  releaseWorkflowPath
] as const
const exactActionPins: Readonly<Record<string, string>> = {
  'actions/attest': '59d89421af93a897026c735860bf21b6eb4f7b26',
  'actions/checkout': 'de0fac2e4500dabe0009e67214ff5f5447ce83dd',
  'actions/download-artifact': '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  'actions/setup-node': '48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
  'actions/upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  return value
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`${label} must be a string`)
  return value
}

function workflow(path: string): Record<string, unknown> {
  return requireRecord(load(readFileSync(path, 'utf8')), path)
}

function workflowJobs(
  document: Readonly<Record<string, unknown>>,
  path: string
): Record<string, unknown> {
  return requireRecord(document['jobs'], `${path} jobs`)
}

function job(
  document: Readonly<Record<string, unknown>>,
  path: string,
  name: string
): Record<string, unknown> {
  return requireRecord(
    workflowJobs(document, path)[name],
    `${path} job ${name}`
  )
}

function jobSteps(
  jobDefinition: Readonly<Record<string, unknown>>,
  label: string
): readonly Record<string, unknown>[] {
  return requireArray(jobDefinition['steps'], `${label} steps`).map(
    (step, index) => requireRecord(step, `${label} step ${index + 1}`)
  )
}

function jobNeeds(jobDefinition: Readonly<Record<string, unknown>>): string[] {
  const needs = jobDefinition['needs']
  if (typeof needs === 'string') return [needs]
  return requireArray(needs, 'job needs').map((name, index) =>
    requireString(name, `job need ${index + 1}`)
  )
}

function collectUses(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectUses)
  if (!isRecord(value)) return []

  return Object.entries(value).flatMap(([key, nestedValue]) => {
    if (key === 'uses') return [requireString(nestedValue, 'uses')]
    return collectUses(nestedValue)
  })
}

function jobHasContentsWrite(
  jobDefinition: Readonly<Record<string, unknown>>
): boolean {
  const permissions = requireRecord(
    jobDefinition['permissions'],
    'job permissions'
  )
  return permissions['contents'] === 'write'
}

test('release-critical third-party actions are pinned to full commit SHAs', () => {
  const observedActions = new Set<string>()
  for (const path of releaseCriticalWorkflowPaths) {
    const document = workflow(path)
    const defaults = requireRecord(document['defaults'], `${path} defaults`)
    const runDefaults = requireRecord(defaults['run'], `${path} run defaults`)
    expect(runDefaults['shell']).toBe('bash')

    for (const definition of Object.values(workflowJobs(document, path))) {
      const jobDefinition = requireRecord(definition, `${path} job`)
      const runner = jobDefinition['runs-on']
      if (typeof runner === 'string') expect(runner).toBe('ubuntu-24.04')

      const steps = jobDefinition['steps']
      if (!Array.isArray(steps)) continue
      for (const [index, value] of steps.entries()) {
        const step = requireRecord(value, `${path} step ${index + 1}`)
        const uses = step['uses']
        if (typeof uses !== 'string') continue
        if (uses.startsWith('actions/checkout@')) {
          const inputs = requireRecord(step['with'], `${path} checkout inputs`)
          expect(inputs['persist-credentials']).toBe(false)
        }
        if (uses.startsWith('actions/setup-node@')) {
          const inputs = requireRecord(
            step['with'],
            `${path} setup-node inputs`
          )
          expect(inputs['node-version-file']).toBe('.node-version')
          expect(inputs).not.toHaveProperty('cache')
        }
      }
    }

    for (const uses of collectUses(document)) {
      if (uses.startsWith('./')) continue
      expect(uses, `${path}: ${uses}`).toMatch(
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u
      )
      const separator = uses.lastIndexOf('@')
      const action = uses.slice(0, separator)
      const pin = uses.slice(separator + 1)
      observedActions.add(action)
      expect(pin, `${path}: unexpected pin for ${action}`).toBe(
        exactActionPins[action]
      )
    }
  }
  expect([...observedActions].sort()).toStrictEqual(
    Object.keys(exactActionPins).sort()
  )
})

test('release controller is canonical, serialized, and version-file driven', () => {
  const document = workflow(releaseWorkflowPath)
  const triggers = requireRecord(document['on'], 'release triggers')
  const push = requireRecord(triggers['push'], 'release push trigger')
  const dispatch = requireRecord(
    triggers['workflow_dispatch'],
    'release dispatch trigger'
  )
  const dispatchInputs = requireRecord(
    dispatch['inputs'],
    'release dispatch inputs'
  )
  const expectedVersion = requireRecord(
    dispatchInputs['expected_version'],
    'expected_version dispatch input'
  )
  const concurrency = requireRecord(
    document['concurrency'],
    'release concurrency'
  )
  const environment = requireRecord(document['env'], 'release environment')
  const prepare = job(document, releaseWorkflowPath, 'prepare')

  expect(document['permissions']).toStrictEqual({})
  expect(push['branches']).toStrictEqual(['main'])
  expect(push['paths']).toStrictEqual(['src/version.ts'])
  expect(expectedVersion['required']).toBe(true)
  expect(Object.keys(dispatchInputs)).toStrictEqual(['expected_version'])
  expect(concurrency).toStrictEqual({
    group: 'release',
    queue: 'max'
  })
  expect(environment['GH_REPO']).toBe('${{ github.repository }}')
  expect(prepare['if']).toContain(
    "github.repository == 'GrantBirki/branch-deploy'"
  )
})

test('required package-check performs release validation without publication privileges', () => {
  const path = '.github/workflows/package-check.yml'
  const document = workflow(path)
  const jobs = workflowJobs(document, path)
  const source = readFileSync(path, 'utf8')
  const dryBuild = job(document, path, 'release-dry-build')
  const requiredCheck = job(document, path, 'package-check')
  const dryBuildInputs = requireRecord(
    dryBuild['with'],
    'release dry-build inputs'
  )

  expect(document['name']).toBe('package-check')
  expect(Object.keys(jobs)).toStrictEqual([
    'package',
    'release-dry-build',
    'package-check'
  ])
  expect(document['permissions']).toStrictEqual({})
  expect(job(document, path, 'package')['permissions']).toStrictEqual({
    contents: 'read'
  })
  expect(dryBuild['uses']).toBe('./.github/workflows/release-build.yml')
  expect(dryBuild['permissions']).toStrictEqual({contents: 'read'})
  expect(dryBuildInputs['perform_attestation']).toBe(false)
  expect(dryBuildInputs).not.toHaveProperty('resume_existing')
  expect(jobNeeds(requiredCheck).sort()).toStrictEqual(
    ['package', 'release-dry-build'].sort()
  )
  expect(source).toContain('script/release-artifacts.ts validate')
  expect(source).toContain('uses: ./.github/workflows/release-build.yml')
  expect(source).toContain('perform_attestation: false')
  expect(source).not.toContain('actions/attest@')
  expect(source).not.toContain('id-token: write')
  expect(source).not.toMatch(
    /gh release create|git push|git tag (?:-[afs]\b|v[0-9])/u
  )
})

test('release jobs preserve the verify-before-publish dependency chain', () => {
  const document = workflow(releaseWorkflowPath)
  const expectedNeeds = {
    build: ['prepare'],
    verify: ['prepare', 'build'],
    publish: ['prepare', 'build', 'verify'],
    verify_release: ['prepare', 'build', 'publish'],
    update_major: ['prepare', 'verify_release'],
    verify_major: ['prepare', 'build', 'update_major']
  } as const

  for (const [name, needs] of Object.entries(expectedNeeds)) {
    expect(
      jobNeeds(job(document, releaseWorkflowPath, name)).sort()
    ).toStrictEqual([...needs].sort())
  }
})

test('every release job has the exact least-privilege permission set', () => {
  const document = workflow(releaseWorkflowPath)
  const expectedPermissions = {
    prepare: {contents: 'read'},
    build: {
      contents: 'read',
      'id-token': 'write',
      attestations: 'write'
    },
    verify: {
      actions: 'read',
      attestations: 'read',
      contents: 'read'
    },
    publish: {
      actions: 'read',
      attestations: 'read',
      contents: 'write'
    },
    verify_release: {
      attestations: 'read',
      contents: 'read'
    },
    update_major: {contents: 'write'},
    verify_major: {contents: 'read'}
  } as const

  for (const [name, permissions] of Object.entries(expectedPermissions)) {
    expect(
      job(document, releaseWorkflowPath, name)['permissions']
    ).toStrictEqual(permissions)
  }
})

test('only minimal publication jobs receive contents write', () => {
  const document = workflow(releaseWorkflowPath)
  const jobs = workflowJobs(document, releaseWorkflowPath)
  const writeJobs = Object.entries(jobs)
    .filter(([, definition]) =>
      jobHasContentsWrite(requireRecord(definition, 'release job'))
    )
    .map(([name]) => name)
    .sort()

  expect(writeJobs).toStrictEqual(['publish', 'update_major'])

  for (const name of writeJobs) {
    const definition = job(document, releaseWorkflowPath, name)
    const steps = jobSteps(definition, `release job ${name}`)

    for (const step of steps) {
      const uses = step['uses']
      if (typeof uses === 'string') {
        expect(uses).not.toContain('actions/checkout@')
        expect(uses).not.toContain('actions/setup-node@')
        expect(uses).not.toMatch(/^\.\//u)
      }

      const run = step['run']
      if (typeof run === 'string') {
        expect(run).not.toMatch(
          /(?:^|\n)\s*(?:bun|deno|node|npm|npx|pnpm|yarn)(?:\s|$)|\$\(\s*(?:bun|deno|node|npm|npx|pnpm|yarn)(?:\s|$)|(?:^|\s)(?:\.\/)?(?:dist|script|src)\//u
        )
      }
    }
  }
})

test('reusable build owns production attestations with narrow permissions', () => {
  const document = workflow(releaseBuildWorkflowPath)
  const triggers = requireRecord(document['on'], 'release-build triggers')
  const build = job(document, releaseBuildWorkflowPath, 'build')
  const attestSteps = jobSteps(build, 'release-build job').filter(step =>
    requireString(step['uses'] ?? '', 'release-build step uses').startsWith(
      'actions/attest@'
    )
  )

  expect(document['permissions']).toStrictEqual({})
  expect(triggers).toHaveProperty('workflow_call')
  expect(
    requireRecord(triggers['workflow_call'], 'workflow_call')
  ).not.toHaveProperty('inputs.resume_existing')
  expect(build['permissions']).toStrictEqual({
    contents: 'read',
    'id-token': 'write',
    attestations: 'write'
  })
  expect(readFileSync('.node-version', 'utf8').trim()).toBe('24.9.0')
  expect(attestSteps).toHaveLength(2)
  expect(readFileSync(releaseBuildWorkflowPath, 'utf8')).toContain(
    'subject-path: ${{ steps.assets.outputs.subject_paths }}'
  )
  expect(readFileSync(releaseBuildWorkflowPath, 'utf8')).toContain(
    'artifact_name=release-$VERSION-$SOURCE_SHA-$RUN_ID-$RUN_ATTEMPT'
  )
  expect(
    readFileSync(releaseBuildWorkflowPath, 'utf8').match(
      /git status --porcelain --untracked-files=all\)/gu
    )
  ).toHaveLength(2)
  for (const step of attestSteps) {
    expect(step['if']).toContain('inputs.perform_attestation')
  }
  expect(readFileSync(releaseBuildWorkflowPath, 'utf8')).not.toContain(
    'resume_existing'
  )
})

test('draft authority and recovery stay inside the write-scoped publisher', () => {
  const document = workflow(releaseWorkflowPath)
  const prepareSource = JSON.stringify(
    job(document, releaseWorkflowPath, 'prepare')
  )
  const publishSource = JSON.stringify(
    job(document, releaseWorkflowPath, 'publish')
  )
  const buildSource = readFileSync(releaseBuildWorkflowPath, 'utf8')

  expect(prepareSource).not.toContain('state=draft')
  expect(prepareSource).not.toContain('.draft == true')
  expect(buildSource).not.toContain('draft release')
  expect(buildSource).not.toContain('resume_existing')
  expect(publishSource).toContain('.draft == true')
  expect(publishSource).toContain('validate_asset_metadata')
  expect(publishSource).toContain('expected-draft-metadata.json')
})

test('release publication verifies archive shape and exact SBOM predicate binding', () => {
  const source = readFileSync(releaseWorkflowPath, 'utf8')

  expect(source).toContain('needs.build.outputs.artifact_digest')
  expect(source).toContain('needs.build.outputs.artifact_id')
  expect(source).toContain('needs.build.outputs.artifact_name')
  expect(source.match(/merge-multiple: true/gu)).toHaveLength(2)
  expect(source).toContain('verificationResult.statement.predicate')
  expect(source).toContain('assert_artifact_identity')
  expect(source).toContain('.source.sha == $source and .source.tree == $tree')
  expect(source).toContain('.state == "uploaded"')
  expect(source).toContain('^sha256:[0-9a-f]{64}$')
  expect(source).toContain(
    'Downloaded release asset $asset_name does not match'
  )
  expect(
    source.match(/contents\/package-lock\.json\?ref=\$SOURCE_SHA/gu)
  ).toHaveLength(3)
  expect(source).toContain('.previousStableTag == $previous_stable')
  expect(
    source.match(/\.source\.sourceDateEpoch == \$source_date_epoch/gu)
  ).toHaveLength(3)
  expect(source).toContain('.lockfile.name == "package-lock.json"')
  expect(source).toContain('.tools.npm == "11.6.0"')
  expect(source).toContain('--no-same-owner')
  expect(source).toContain('--no-same-permissions')
  expect(source).toContain('tar --list --verbose --gzip')
  expect(source).toContain('assert_current_version_is_newer')
  expect(source).toContain('releases-before-major-update.json')
  expect(source).toContain(
    'A draft or published GitHub Release must never be attached'
  )
})

test('same-source drafts are the only drafts eligible for resume', () => {
  const source = readFileSync(releaseWorkflowPath, 'utf8')

  expect(source).toContain('.draft == true and .target_commitish == $source')
  expect(source).toContain(
    'SOURCE_SHA: ${{ needs.prepare.outputs.source_sha }}'
  )
  expect(source).toContain(
    'An existing release belongs to a different workflow event SHA'
  )
})

test('draft recovery uploads only missing assets and never clobbers', () => {
  const source = readFileSync(releaseWorkflowPath, 'utf8')

  expect(source).toContain('if [[ ! -f "$RUNNER_TEMP/existing-assets/$name" ]]')
  expect(source).toContain('gh release upload "$VERSION"')
  expect(source).not.toContain('gh release upload --clobber')
  expect(source).not.toContain('gh release delete-asset')
})

test('mismatched and older drafts fail before publication', () => {
  const source = readFileSync(releaseWorkflowPath, 'utf8')

  expect(source).toContain('.target_commitish == $source')
  expect(source).toContain(
    'The exact-version tag points at $tag_target instead of $SOURCE_SHA'
  )
  expect(source).toContain('cmp "$RUNNER_TEMP/existing-assets/$name"')
})

test('published immutable releases take the verification-only retry path', () => {
  const source = readFileSync(releaseWorkflowPath, 'utf8')

  expect(source).toContain('state=published')
  expect(source).toContain('.immutable // false')
  expect(source).toContain(
    "needs.prepare.outputs.state == 'published' || needs.publish.result == 'success'"
  )
  expect(source).toContain("needs.prepare.outputs.state != 'published'")
})

test('orphan and conflicting exact tags fail closed', () => {
  const source = readFileSync(releaseWorkflowPath, 'utf8')

  expect(source).toContain(
    'already exists at $tag_target without a matching draft release'
  )
  expect(source).toContain('resolve_tag_commit "$VERSION"')
  expect(source).toContain('[[ "$tag_target" == "$SOURCE_SHA" ]]')
})

test('stable alias updates are idempotent after immutable verification', () => {
  const document = workflow(releaseWorkflowPath)
  const updateMajor = job(document, releaseWorkflowPath, 'update_major')
  const verifyMajor = job(document, releaseWorkflowPath, 'verify_major')
  const source = JSON.stringify({updateMajor, verifyMajor})
  const updateMajorRun = jobSteps(updateMajor, 'update major job')
    .map(step => (typeof step['run'] === 'string' ? step['run'] : ''))
    .join('\n')

  expect(jobNeeds(updateMajor)).toContain('verify_release')
  expect(source).toContain('git/ref/tags/$MAJOR_TAG')
  expect(source).toContain('git/refs/tags/$MAJOR_TAG')
  expect(source).toContain('SOURCE_SHA')
  expect(source).toContain('releases-after-major-update.json')
  expect(updateMajorRun).toContain('resolve_tag_commit "$MAJOR_TAG"')
})

test('manual dispatch rejects stale main, wrong version, and baseline publication', () => {
  const source = readFileSync(releaseWorkflowPath, 'utf8')

  expect(source).toContain('[[ "$GITHUB_REF" != \'refs/heads/main\' ]]')
  expect(source).toContain('[[ "$EXPECTED_VERSION" != "$current_version" ]]')
  expect(source).toContain('[[ "$EVENT_SHA" != "$main_sha" ]]')
  expect(source).toContain('--previous v11.1.5')
})

test('push validation compares the event before SHA to the frozen source', () => {
  const source = readFileSync(releaseWorkflowPath, 'utf8')

  expect(source).toContain('--previous v11.1.5')
  expect(source).toContain('EVENT_BEFORE: ${{ github.event.before }}')
  expect(source).toContain('git show "$EVENT_BEFORE:src/version.ts"')
  expect(source).toContain('--previous "$previous_version"')
  expect(source).toContain('EVENT_SHA: ${{ github.sha }}')
})

test('release assets and exact-versus-major tag policy stay fixed', () => {
  const buildSource = readFileSync(releaseBuildWorkflowPath, 'utf8')
  const releaseSource = readFileSync(releaseWorkflowPath, 'utf8')
  const artifactSource = readFileSync('script/release-artifacts.ts', 'utf8')
  const document = workflow(releaseWorkflowPath)
  const updateMajor = job(document, releaseWorkflowPath, 'update_major')
  const updateMajorSource = JSON.stringify(updateMajor)

  for (const asset of [
    '.tar.gz',
    '.spdx.json',
    '.release.json',
    'SHA256SUMS',
    '.provenance.sigstore.jsonl',
    '.sbom.sigstore.jsonl'
  ]) {
    expect(
      `${buildSource}\n${artifactSource}`,
      `missing release asset policy for ${asset}`
    ).toContain(asset)
  }

  expect(updateMajor['if']).toContain(
    "needs.prepare.outputs.update_major == 'true'"
  )
  expect(updateMajorSource).not.toContain('gh release')
  expect(releaseSource).not.toMatch(/major_minor|major-minor|vMAJOR\.MINOR/iu)
  expect(existsSync('script/release')).toBe(false)
  expect(existsSync('.github/workflows/update-latest-release-tag.yml')).toBe(
    false
  )
})
