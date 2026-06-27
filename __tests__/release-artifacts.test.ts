import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync
} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {gunzipSync, gzipSync} from 'node:zlib'
import {load} from 'js-yaml'
import {afterEach, describe, expect, test, vi} from 'vitest'
import {
  buildReleaseArtifacts,
  inspectReleaseArchive,
  normalizeSpdxDocument,
  parseReleaseJson,
  requireInflateBytesWritten,
  runReleaseArtifactsCli,
  validateReleaseSpdxDocument,
  verifyReleaseArtifacts
} from '../src/release-artifacts.ts'

const SOURCE_SHA = 'a'.repeat(40)
const TREE_SHA = 'b'.repeat(40)
const SOURCE_DATE_EPOCH = 1_700_000_000
const temporaryDirectories: string[] = []
const npmVersion = spawnSync('npm', ['--version'], {encoding: 'utf8'})
if (npmVersion.status !== 0) throw new Error(npmVersion.stderr)
const TOOL_VERSIONS = {
  node: process.version,
  npm: npmVersion.stdout.trim(),
  ncc: '0.44.0'
} as const

function npmSpdxInput(version = 'v11.1.6-rc.1') {
  const packageVersion = version.slice(1)
  const rootId = `SPDXRef-Package-branch-deploy-${packageVersion}`
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'dynamic name',
    documentNamespace: 'urn:uuid:dynamic',
    creationInfo: {
      created: '2099-01-01T00:00:00.000Z',
      creators: ['Tool: npm/cli-test']
    },
    documentDescribes: [rootId],
    packages: [
      {
        name: 'z-package',
        SPDXID: 'SPDXRef-Package-z',
        downloadLocation: 'NOASSERTION'
      },
      {
        name: 'branch-deploy',
        SPDXID: rootId,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        packageFileName: '',
        primaryPackagePurpose: 'APPLICATION',
        versionInfo: packageVersion
      },
      {
        name: 'a-package',
        SPDXID: 'SPDXRef-Package-a',
        downloadLocation: 'NOASSERTION'
      }
    ],
    relationships: [
      {
        spdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DESCRIBES',
        relatedSpdxElement: rootId
      }
    ]
  }
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function parseJsonFile(path: string): Record<string, unknown> {
  return requireRecord(load(readFileSync(path, 'utf8')), path)
}

function createProjectFixture(): string {
  const projectRoot = temporaryDirectory('branch-deploy-artifacts-project-')
  mkdirSync(resolve(projectRoot, 'dist'))
  writeFileSync(resolve(projectRoot, 'action.yml'), 'name: fixture\n')
  for (const file of [
    'index.js',
    'index.js.map',
    'licenses.txt',
    'package.json',
    'sourcemap-register.cjs',
    'sourcemap-register.js'
  ]) {
    writeFileSync(resolve(projectRoot, 'dist', file), `${file}\n`)
  }
  writeFileSync(
    resolve(projectRoot, 'package-lock.json'),
    `${JSON.stringify({
      lockfileVersion: 3,
      packages: {'node_modules/@vercel/ncc': {version: '0.44.0'}}
    })}\n`
  )
  return projectRoot
}

function tarEntryNames(archive: Buffer): string[] {
  const tar = gunzipSync(archive)
  const names: string[] = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const nameEnd = header.indexOf(0)
    const name = header
      .subarray(0, nameEnd === -1 ? 100 : nameEnd)
      .toString('utf8')
    const sizeEnd = header.indexOf(0, 124)
    const size = Number.parseInt(
      header.subarray(124, sizeEnd === -1 ? 136 : sizeEnd).toString('utf8'),
      8
    )
    names.push(name)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

function deterministicGzip(tar: Buffer): Buffer {
  const archive = gzipSync(tar, {level: 9})
  archive.fill(0, 4, 8)
  archive[9] = 0xff
  return archive
}

function tarEntryOffsets(tar: Buffer): number[] {
  const offsets: number[] = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    offsets.push(offset)
    const size = Number.parseInt(header.subarray(124, 135).toString('ascii'), 8)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return offsets
}

function refreshTarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156)
  let checksum = 0
  for (const byte of header) checksum += byte
  const encoded = `${checksum.toString(8).padStart(6, '0')}\0 `
  header.write(encoded, 148, 8, 'ascii')
}

function setTarString(
  header: Buffer,
  offset: number,
  length: number,
  value: string
): void {
  header.fill(0, offset, offset + length)
  header.write(value, offset, length, 'utf8')
}

function setTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  setTarString(
    header,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, '0')}\0`
  )
}

function mutateTarHeader(
  archive: Buffer,
  entryIndex: number,
  mutate: (header: Buffer, tar: Buffer, offset: number) => void,
  refreshChecksum = true
): Buffer {
  const tar = gunzipSync(archive)
  const offset = tarEntryOffsets(tar)[entryIndex]
  if (offset === undefined) throw new Error('Missing test tar entry')
  const header = tar.subarray(offset, offset + 512)
  mutate(header, tar, offset)
  if (refreshChecksum) refreshTarChecksum(header)
  return deterministicGzip(tar)
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function artifactFileNames(version: string) {
  const prefix = `branch-deploy-${version}`
  return {
    archive: `${prefix}.tar.gz`,
    manifest: `${prefix}.release.json`,
    sbom: `${prefix}.spdx.json`
  }
}

function rewriteChecksums(outputDirectory: string, version: string): void {
  const names = artifactFileNames(version)
  const archive = readFileSync(resolve(outputDirectory, names.archive))
  const sbom = readFileSync(resolve(outputDirectory, names.sbom))
  const manifest = readFileSync(resolve(outputDirectory, names.manifest))
  writeFileSync(
    resolve(outputDirectory, 'SHA256SUMS'),
    `${sha256(archive)}  ${names.archive}\n${sha256(sbom)}  ${names.sbom}\n${sha256(manifest)}  ${names.manifest}\n`
  )
}

function mutateJsonArtifact(
  outputDirectory: string,
  name: string,
  mutate: (value: Record<string, unknown>) => void
): void {
  const path = resolve(outputDirectory, name)
  const value = requireRecord(JSON.parse(readFileSync(path, 'utf8')), name)
  mutate(value)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function refreshManifestArtifactMetadata(
  outputDirectory: string,
  version: string,
  artifact: 'archive' | 'sbom'
): void {
  const names = artifactFileNames(version)
  const artifactName = names[artifact]
  const content = readFileSync(resolve(outputDirectory, artifactName))
  mutateJsonArtifact(outputDirectory, names.manifest, manifest => {
    const artifacts = requireRecord(manifest['artifacts'], 'artifacts')
    const metadata = requireRecord(artifacts[artifact], artifact)
    metadata['sha256'] = sha256(content)
    metadata['size'] = content.length
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {recursive: true, force: true})
  }
})

describe('SPDX normalization', () => {
  test('replaces nondeterministic npm fields and canonicalizes collections', () => {
    const normalized = normalizeSpdxDocument(
      npmSpdxInput(),
      'v11.1.6-rc.1',
      SOURCE_SHA,
      SOURCE_DATE_EPOCH
    )

    expect(normalized['name']).toBe('branch-deploy-v11.1.6-rc.1 action bundle')
    expect(normalized['documentNamespace']).toBe(
      `https://github.com/GrantBirki/branch-deploy/sbom/v11.1.6-rc.1/${SOURCE_SHA}`
    )
    expect(normalized['creationInfo']).toStrictEqual({
      created: '2023-11-14T22:13:20.000Z',
      creators: ['Tool: npm/cli-test']
    })
    const packages = normalized['packages']
    expect(packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'branch-deploy',
          primaryPackagePurpose: 'APPLICATION',
          versionInfo: '11.1.6-rc.1'
        })
      ])
    )

    const duplicateCreators = npmSpdxInput()
    duplicateCreators.creationInfo.creators.push('Tool: npm/cli-test')
    const duplicateCreationInfo = requireRecord(
      normalizeSpdxDocument(
        duplicateCreators,
        'v11.1.6-rc.1',
        SOURCE_SHA,
        SOURCE_DATE_EPOCH
      )['creationInfo'],
      'creationInfo'
    )
    expect(duplicateCreationInfo['creators']).toHaveLength(2)
  })

  test('rejects a non-SPDX npm document', () => {
    expect(() =>
      normalizeSpdxDocument(
        {...npmSpdxInput('v11.1.6'), spdxVersion: 'SPDX-2.2'},
        'v11.1.6',
        SOURCE_SHA,
        SOURCE_DATE_EPOCH
      )
    ).toThrow('npm SPDX document must use SPDX-2.3')
    expect(() =>
      normalizeSpdxDocument(
        {...npmSpdxInput('v11.1.6'), packages: 'invalid'},
        'v11.1.6',
        SOURCE_SHA,
        SOURCE_DATE_EPOCH
      )
    ).toThrow('npm SPDX document must contain a packages array')
  })

  test('validates the complete normalized SPDX release identity', () => {
    const normalized = normalizeSpdxDocument(
      npmSpdxInput(),
      'v11.1.6-rc.1',
      SOURCE_SHA,
      SOURCE_DATE_EPOCH
    )
    const invalidCases: readonly {
      readonly message: string
      readonly mutate: (document: Record<string, unknown>) => void
    }[] = [
      {
        message: 'must use SPDX-2.3',
        mutate: document => {
          document['spdxVersion'] = 'SPDX-2.2'
        }
      },
      {
        message: 'must use SPDXRef-DOCUMENT',
        mutate: document => {
          document['SPDXID'] = 'wrong'
        }
      },
      {
        message: 'CC0-1.0',
        mutate: document => {
          document['dataLicense'] = 'MIT'
        }
      },
      {
        message: 'name does not match',
        mutate: document => {
          document['name'] = 'wrong'
        }
      },
      {
        message: 'namespace does not match',
        mutate: document => {
          document['documentNamespace'] = 'https://example.invalid'
        }
      },
      {
        message: 'timestamp does not match',
        mutate: document => {
          requireRecord(document['creationInfo'], 'creationInfo')['created'] =
            '2000-01-01T00:00:00.000Z'
        }
      },
      {
        message: 'creators must be an array',
        mutate: document => {
          requireRecord(document['creationInfo'], 'creationInfo')['creators'] =
            'invalid'
        }
      },
      {
        message: 'creators must not be empty',
        mutate: document => {
          requireRecord(document['creationInfo'], 'creationInfo')['creators'] =
            []
        }
      },
      {
        message: 'creator 0 must not be empty',
        mutate: document => {
          requireRecord(document['creationInfo'], 'creationInfo')['creators'] =
            ['']
        }
      },
      {
        message: 'packages must be an array',
        mutate: document => {
          document['packages'] = 'invalid'
        }
      },
      {
        message: 'package 0 must be a JSON object',
        mutate: document => {
          document['packages'] = ['invalid']
        }
      },
      {
        message: 'package 0 SPDXID must not be empty',
        mutate: document => {
          const packages = document['packages']
          if (!Array.isArray(packages)) throw new TypeError('packages')
          requireRecord(packages[0], 'package')['SPDXID'] = ''
        }
      },
      {
        message: 'package 0 name must be a string',
        mutate: document => {
          const packages = document['packages']
          if (!Array.isArray(packages)) throw new TypeError('packages')
          requireRecord(packages[0], 'package')['name'] = 1
        }
      },
      {
        message: 'package 0 downloadLocation must not be empty',
        mutate: document => {
          const packages = document['packages']
          if (!Array.isArray(packages)) throw new TypeError('packages')
          requireRecord(packages[0], 'package')['downloadLocation'] = ''
        }
      },
      {
        message: 'exactly one branch-deploy package',
        mutate: document => {
          const packages = document['packages']
          if (!Array.isArray(packages)) throw new TypeError('packages')
          for (const packageValue of packages) {
            const record = requireRecord(packageValue, 'package')
            if (record['name'] === 'branch-deploy') record['name'] = 'renamed'
          }
        }
      },
      {
        message: 'root package does not match',
        mutate: document => {
          const packages = document['packages']
          if (!Array.isArray(packages)) throw new TypeError('packages')
          const root = packages
            .map(value => requireRecord(value, 'package'))
            .find(value => value['name'] === 'branch-deploy')
          if (root === undefined) throw new TypeError('root')
          root['primaryPackagePurpose'] = 'LIBRARY'
        }
      },
      {
        message: 'documentDescribes must identify',
        mutate: document => {
          document['documentDescribes'] = []
        }
      },
      {
        message: 'relationships must be an array',
        mutate: document => {
          document['relationships'] = 'invalid'
        }
      },
      {
        message: 'relationship 0 must be a JSON object',
        mutate: document => {
          document['relationships'] = ['invalid']
        }
      },
      {
        message: 'relationships must describe',
        mutate: document => {
          document['relationships'] = []
        }
      }
    ]

    for (const {message, mutate} of invalidCases) {
      const document = structuredClone(normalized)
      mutate(document)
      expect(() => {
        validateReleaseSpdxDocument(
          document,
          'v11.1.6-rc.1',
          SOURCE_SHA,
          SOURCE_DATE_EPOCH
        )
      }).toThrow(message)
    }

    expect(() => {
      validateReleaseSpdxDocument(
        undefined,
        'v11.1.6-rc.1',
        SOURCE_SHA,
        SOURCE_DATE_EPOCH
      )
    }).toThrow('not valid JSON')
    expect(() => {
      validateReleaseSpdxDocument(
        {value: Number.NaN},
        'v11.1.6-rc.1',
        SOURCE_SHA,
        SOURCE_DATE_EPOCH
      )
    }).toThrow('non-finite number')
  })
})

describe('duplicate-aware release JSON parsing', () => {
  test('accepts the complete JSON grammar used by release documents', () => {
    expect(
      parseReleaseJson(
        ' {"array":[true,false,null,-1.25e+3,"escaped\\nvalue","unicode\\u0061"],"emptyArray":[],"emptyObject":{}} \n',
        'fixture'
      )
    ).toStrictEqual({
      array: [true, false, null, -1250, 'escaped\nvalue', 'unicodea'],
      emptyArray: [],
      emptyObject: {}
    })
  })

  test.each([
    '{"key":1,"key":2}',
    '{"schemaVersion":1,"sch\\u0065maVersion":2}',
    '{"outer":{"key":1,"key":2}}'
  ])('rejects duplicate keys in %s', document => {
    expect(() => parseReleaseJson(document, 'fixture')).toThrow(
      'Duplicate JSON object key'
    )
  })

  test.each([
    ['', 'Invalid JSON number'],
    ['?', 'Invalid JSON number'],
    ['true false', 'Unexpected JSON content'],
    ['tru', 'Invalid JSON token'],
    ['{"key" 1}', 'Expected a JSON object colon'],
    ['{key:1}', 'Expected a JSON object key'],
    ['{"key":1', 'Expected a JSON object separator'],
    ['{', 'Unterminated JSON object'],
    ['[1 2]', 'Expected a JSON array separator'],
    ['[', 'Unterminated JSON array'],
    ['"invalid\\x"', 'Invalid JSON string escape'],
    ['"invalid\\u00xx"', 'Invalid JSON Unicode escape'],
    ['"unterminated', 'Unterminated JSON string'],
    ['"trailing\\', 'Invalid JSON string escape'],
    [`"control${String.fromCharCode(1)}"`, 'Invalid JSON string character']
  ])('rejects malformed JSON %j', (document, message) => {
    expect(() => parseReleaseJson(document, 'fixture')).toThrow(message)
  })
})

describe('deterministic release artifacts', () => {
  test('requires byte accounting from the raw inflate engine', () => {
    expect(requireInflateBytesWritten({engine: {bytesWritten: 12}})).toBe(12)
    for (const value of [null, [], {}, {engine: null}, {engine: {}}]) {
      expect(() => requireInflateBytesWritten(value)).toThrow('Raw inflate')
    }
  })

  test('builds identical archives, SBOMs, manifests, and checksums', () => {
    const projectRoot = createProjectFixture()
    const firstOutput = temporaryDirectory('branch-deploy-artifacts-first-')
    const secondOutput = temporaryDirectory('branch-deploy-artifacts-second-')
    const sharedOptions = {
      projectRoot,
      version: 'v11.1.6-rc.1',
      sourceSha: SOURCE_SHA,
      treeSha: TREE_SHA,
      previousStableTag: 'v11.1.2',
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      spdxInput: npmSpdxInput(),
      toolVersions: TOOL_VERSIONS
    }
    const first = buildReleaseArtifacts({
      ...sharedOptions,
      outputDirectory: firstOutput
    })
    const second = buildReleaseArtifacts({
      ...sharedOptions,
      outputDirectory: secondOutput
    })

    for (const paths of [
      {first: first.archivePath, second: second.archivePath},
      {first: first.sbomPath, second: second.sbomPath},
      {first: first.manifestPath, second: second.manifestPath},
      {first: first.checksumsPath, second: second.checksumsPath}
    ]) {
      expect(readFileSync(paths.first)).toStrictEqual(
        readFileSync(paths.second)
      )
    }

    expect(tarEntryNames(readFileSync(first.archivePath))).toStrictEqual([
      'branch-deploy-v11.1.6-rc.1/',
      'branch-deploy-v11.1.6-rc.1/action.yml',
      'branch-deploy-v11.1.6-rc.1/dist/',
      'branch-deploy-v11.1.6-rc.1/dist/index.js',
      'branch-deploy-v11.1.6-rc.1/dist/index.js.map',
      'branch-deploy-v11.1.6-rc.1/dist/licenses.txt',
      'branch-deploy-v11.1.6-rc.1/dist/package.json',
      'branch-deploy-v11.1.6-rc.1/dist/sourcemap-register.cjs',
      'branch-deploy-v11.1.6-rc.1/dist/sourcemap-register.js'
    ])
    expect([
      ...inspectReleaseArchive(
        readFileSync(first.archivePath),
        'v11.1.6-rc.1',
        SOURCE_DATE_EPOCH
      ).keys()
    ]).toStrictEqual(tarEntryNames(readFileSync(first.archivePath)))
    expect(first.provenanceBundleName).toBe(
      'branch-deploy-v11.1.6-rc.1.provenance.sigstore.jsonl'
    )
    expect(first.sbomBundleName).toBe(
      'branch-deploy-v11.1.6-rc.1.sbom.sigstore.jsonl'
    )
    expect(first.subjectPaths).toHaveLength(11)

    const manifest = parseJsonFile(first.manifestPath)
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      version: 'v11.1.6-rc.1',
      previousStableTag: 'v11.1.2',
      source: {
        sha: SOURCE_SHA,
        tree: TREE_SHA,
        sourceDateEpoch: SOURCE_DATE_EPOCH
      },
      tools: TOOL_VERSIONS
    })
    expect(manifest['lockfile']).toMatchObject({name: 'package-lock.json'})

    expect(
      verifyReleaseArtifacts({
        outputDirectory: firstOutput,
        projectRoot,
        version: 'v11.1.6-rc.1',
        sourceSha: SOURCE_SHA,
        treeSha: TREE_SHA
      })
    ).toMatchObject({
      version: 'v11.1.6-rc.1',
      archivedFiles: [
        'action.yml',
        'dist/index.js',
        'dist/index.js.map',
        'dist/licenses.txt',
        'dist/package.json',
        'dist/sourcemap-register.cjs',
        'dist/sourcemap-register.js'
      ]
    })
  })

  test('builds deterministic application SBOMs with the installed npm', () => {
    const firstOutput = temporaryDirectory('branch-deploy-real-sbom-first-')
    const secondOutput = temporaryDirectory('branch-deploy-real-sbom-second-')
    const sharedOptions = {
      projectRoot: resolve('.'),
      version: 'v11.1.6-rc.1',
      sourceSha: SOURCE_SHA,
      treeSha: TREE_SHA,
      previousStableTag: 'v11.1.2',
      sourceDateEpoch: SOURCE_DATE_EPOCH
    }
    const first = buildReleaseArtifacts({
      ...sharedOptions,
      outputDirectory: firstOutput
    })
    const second = buildReleaseArtifacts({
      ...sharedOptions,
      outputDirectory: secondOutput
    })

    for (const paths of [
      {first: first.archivePath, second: second.archivePath},
      {first: first.sbomPath, second: second.sbomPath},
      {first: first.manifestPath, second: second.manifestPath},
      {first: first.checksumsPath, second: second.checksumsPath}
    ]) {
      expect(readFileSync(paths.first)).toStrictEqual(
        readFileSync(paths.second)
      )
    }

    const sbom = parseJsonFile(first.sbomPath)
    const packages = sbom['packages']
    if (!Array.isArray(packages)) throw new TypeError('packages')
    const rootPackage = packages
      .map(value => requireRecord(value, 'package'))
      .find(value => value['name'] === 'branch-deploy')
    expect(rootPackage).toMatchObject({
      primaryPackagePurpose: 'APPLICATION',
      versionInfo: '11.1.6-rc.1'
    })
    expect(
      verifyReleaseArtifacts({
        outputDirectory: firstOutput,
        version: 'v11.1.6-rc.1',
        sourceSha: SOURCE_SHA,
        treeSha: TREE_SHA
      }).version
    ).toBe('v11.1.6-rc.1')
  }, 30_000)

  test('rejects artifact tampering and unsafe build inputs', () => {
    const projectRoot = createProjectFixture()
    const outputDirectory = temporaryDirectory(
      'branch-deploy-artifacts-tamper-'
    )
    const artifacts = buildReleaseArtifacts({
      projectRoot,
      outputDirectory,
      version: 'v11.1.6',
      sourceSha: SOURCE_SHA,
      treeSha: TREE_SHA,
      previousStableTag: 'v11.1.2',
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      spdxInput: npmSpdxInput('v11.1.6'),
      toolVersions: TOOL_VERSIONS
    })
    writeFileSync(artifacts.archivePath, 'tampered')

    expect(() =>
      verifyReleaseArtifacts({
        outputDirectory,
        projectRoot,
        version: 'v11.1.6',
        sourceSha: SOURCE_SHA,
        treeSha: TREE_SHA
      })
    ).toThrow('Checksum mismatch')
    expect(() =>
      buildReleaseArtifacts({
        projectRoot,
        outputDirectory: temporaryDirectory('branch-deploy-artifacts-invalid-'),
        version: 'v11.1.6',
        sourceSha: SOURCE_SHA,
        treeSha: TREE_SHA,
        previousStableTag: 'v11.1.2-rc.1',
        sourceDateEpoch: SOURCE_DATE_EPOCH,
        spdxInput: npmSpdxInput('v11.1.6'),
        toolVersions: TOOL_VERSIONS
      })
    ).toThrow('previousStableTag must identify a stable release')

    const build = (
      overrides: Partial<Parameters<typeof buildReleaseArtifacts>[0]> = {}
    ) =>
      buildReleaseArtifacts({
        projectRoot,
        outputDirectory: temporaryDirectory(
          'branch-deploy-artifacts-invalid-input-'
        ),
        version: 'v11.1.6',
        sourceSha: SOURCE_SHA,
        treeSha: TREE_SHA,
        previousStableTag: 'v11.1.2',
        sourceDateEpoch: SOURCE_DATE_EPOCH,
        spdxInput: npmSpdxInput('v11.1.6'),
        toolVersions: TOOL_VERSIONS,
        ...overrides
      })

    expect(() => build({previousStableTag: 'v11.1.6'})).toThrow(
      'must precede the release version'
    )
    expect(() => build({previousStableTag: 'v12.0.0'})).toThrow(
      'must precede the release version'
    )
    expect(() => build({sourceSha: 'invalid'})).toThrow(
      'sourceSha must be a lowercase 40-character Git SHA'
    )
    expect(() => build({treeSha: 'invalid'})).toThrow(
      'treeSha must be a lowercase 40-character Git SHA'
    )
    expect(() => build({sourceDateEpoch: -1})).toThrow('USTAR timestamp field')
    expect(() => build({sourceDateEpoch: 0o100000000000})).toThrow(
      'USTAR timestamp field'
    )

    expect(() => build({outputDirectory})).toThrow(
      'Release output directory must be empty'
    )

    const unexpectedDistProject = createProjectFixture()
    writeFileSync(
      resolve(unexpectedDistProject, 'dist/unexpected'),
      'unexpected'
    )
    expect(() => build({projectRoot: unexpectedDistProject})).toThrow(
      'dist must contain exactly'
    )

    const symlinkProject = createProjectFixture()
    rmSync(resolve(symlinkProject, 'dist/index.js'))
    symlinkSync('../action.yml', resolve(symlinkProject, 'dist/index.js'))
    expect(() => build({projectRoot: symlinkProject})).toThrow(
      'Release input must be a regular file: dist/index.js'
    )

    expect(() =>
      build({
        version:
          'v9007199254740991.9007199254740991.9007199254740991-rc.9007199254740991'
      })
    ).toThrow('Tar entry value is too long')
  })

  test('strictly rejects malformed gzip and USTAR structures', () => {
    const projectRoot = createProjectFixture()
    const outputDirectory = temporaryDirectory(
      'branch-deploy-artifacts-archive-validation-'
    )
    const artifacts = buildReleaseArtifacts({
      projectRoot,
      outputDirectory,
      version: 'v11.1.6-rc.1',
      sourceSha: SOURCE_SHA,
      treeSha: TREE_SHA,
      previousStableTag: 'v11.1.2',
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      spdxInput: npmSpdxInput(),
      toolVersions: TOOL_VERSIONS
    })
    const archive = readFileSync(artifacts.archivePath)
    const inspect = (value: Buffer) =>
      inspectReleaseArchive(value, 'v11.1.6-rc.1', SOURCE_DATE_EPOCH)

    for (const mutate of [
      (value: Buffer) => value.subarray(0, 10),
      (value: Buffer) => {
        value[0] = 0
        return value
      },
      (value: Buffer) => {
        value[1] = 0
        return value
      },
      (value: Buffer) => {
        value[2] = 0
        return value
      },
      (value: Buffer) => {
        value[3] = 1
        return value
      },
      (value: Buffer) => {
        value[4] = 1
        return value
      },
      (value: Buffer) => {
        value[8] = 0
        return value
      },
      (value: Buffer) => {
        value[9] = 0
        return value
      }
    ]) {
      const invalid = mutate(Buffer.from(archive))
      expect(() => inspect(invalid)).toThrow('deterministic gzip header')
    }
    expect(() => inspect(Buffer.concat([archive, archive]))).toThrow(
      'exactly one canonical gzip member'
    )
    expect(() => inspect(Buffer.concat([archive, Buffer.from([0])]))).toThrow(
      'exactly one canonical gzip member'
    )

    const invalidHeaders: readonly {
      readonly message: string
      readonly refreshChecksum?: boolean
      readonly mutate: (header: Buffer, tar: Buffer, offset: number) => void
    }[] = [
      {
        message: 'nonzero bytes after its terminator',
        mutate: header => {
          const terminator = header.indexOf(0)
          header[terminator + 1] = 1
        }
      },
      {
        message: 'not valid UTF-8',
        mutate: header => {
          header[0] = 0xff
        }
      },
      {
        message: 'Unsafe tar entry path',
        mutate: header => {
          setTarString(header, 0, 100, '../unsafe')
        }
      },
      {
        message: 'checksum field is malformed',
        refreshChecksum: false,
        mutate: header => {
          header[148] = 'x'.charCodeAt(0)
        }
      },
      {
        message: 'checksum mismatch',
        refreshChecksum: false,
        mutate: header => {
          header[500] = 1
        }
      },
      {
        message: 'does not use USTAR magic',
        mutate: header => {
          header[257] = 0
        }
      },
      {
        message: 'does not use USTAR version 00',
        mutate: header => {
          header[263] = '1'.charCodeAt(0)
        }
      },
      ...[
        [157, 'Tar link name'],
        [265, 'Tar owner name'],
        [297, 'Tar group name'],
        [329, 'Tar device major'],
        [337, 'Tar device minor'],
        [345, 'Tar path prefix'],
        [500, 'Tar header padding']
      ].map(([offset, message]) => ({
        message: `${String(message)} must be empty`,
        mutate: (header: Buffer) => {
          header[Number(offset)] = 1
        }
      })),
      {
        message: 'entry order or name is invalid',
        mutate: header => {
          setTarString(header, 0, 100, 'safe-but-wrong')
        }
      },
      {
        message: 'entry type is invalid',
        mutate: header => {
          header[156] = '2'.charCodeAt(0)
        }
      },
      {
        message: 'mode is invalid',
        mutate: header => {
          setTarOctal(header, 100, 8, 0o700)
        }
      },
      {
        message: 'ownership is invalid',
        mutate: header => {
          setTarOctal(header, 108, 8, 1)
        }
      },
      {
        message: 'ownership is invalid',
        mutate: header => {
          setTarOctal(header, 116, 8, 1)
        }
      },
      {
        message: 'directory entry has content',
        mutate: header => {
          setTarOctal(header, 124, 12, 1)
        }
      },
      {
        message: 'timestamp is invalid',
        mutate: header => {
          setTarOctal(header, 136, 12, SOURCE_DATE_EPOCH + 1)
        }
      },
      {
        message: 'not a canonical USTAR octal field',
        mutate: header => {
          setTarString(header, 100, 8, '0000008\0')
        }
      },
      {
        message: 'entry name is not valid',
        mutate: header => {
          header.fill('a'.charCodeAt(0), 0, 100)
        }
      }
    ]

    for (const {message, mutate, refreshChecksum} of invalidHeaders) {
      const invalid = mutateTarHeader(
        archive,
        0,
        mutate,
        refreshChecksum ?? true
      )
      expect(() => inspect(invalid), message).toThrow(
        message === 'entry name is not valid'
          ? 'entry order or name is invalid'
          : message
      )
    }

    const nonzeroPadding = mutateTarHeader(
      archive,
      1,
      (_header, tar, offset) => {
        const size = Number.parseInt(
          tar.subarray(offset + 124, offset + 135).toString('ascii'),
          8
        )
        tar[offset + 512 + size] = 1
      }
    )
    expect(() => inspect(nonzeroPadding)).toThrow('padding is nonzero')
    const oversizedContent = mutateTarHeader(archive, 1, header => {
      setTarOctal(header, 124, 12, 0o77777777777)
    })
    expect(() => inspect(oversizedContent)).toThrow(
      'content exceeds the archive'
    )

    const tar = gunzipSync(archive)
    const offsets = tarEntryOffsets(tar)
    const firstBlock = tar.subarray(offsets[0], (offsets[0] ?? 0) + 512)
    const withoutFooter = tar.subarray(0, tar.length - 1024)
    const withDuplicate = deterministicGzip(
      Buffer.concat([withoutFooter, firstBlock, Buffer.alloc(1024)])
    )
    expect(() => inspect(withDuplicate)).toThrow('duplicate entry')

    const extraHeader = Buffer.from(firstBlock)
    setTarString(extraHeader, 0, 100, 'extra')
    refreshTarChecksum(extraHeader)
    expect(() =>
      inspect(
        deterministicGzip(
          Buffer.concat([withoutFooter, extraHeader, Buffer.alloc(1024)])
        )
      )
    ).toThrow('entry order or name is invalid')
    expect(() =>
      inspect(
        deterministicGzip(Buffer.concat([firstBlock, Buffer.alloc(1024)]))
      )
    ).toThrow('missing expected entries')
    expect(() =>
      inspect(deterministicGzip(Buffer.concat([tar, Buffer.alloc(512)])))
    ).toThrow('premature zero block')
    expect(() =>
      inspect(deterministicGzip(tar.subarray(0, tar.length - 512)))
    ).toThrow('missing its two-block terminator')
    expect(() => inspect(deterministicGzip(withoutFooter))).toThrow(
      'must end with two zero blocks'
    )
    expect(() => inspect(deterministicGzip(Buffer.alloc(0)))).toThrow(
      'missing its two-block terminator'
    )
    const invalidFooter = Buffer.from(tar)
    invalidFooter[invalidFooter.length - 1] = 1
    expect(() => inspect(deterministicGzip(invalidFooter))).toThrow(
      'must end with two zero blocks'
    )
    expect(() =>
      inspect(deterministicGzip(Buffer.concat([tar, Buffer.from([0])])))
    ).toThrow('multiple of 512')
    expect(() =>
      inspectReleaseArchive(archive, 'v11.1.6-rc.1', 0o100000000000)
    ).toThrow('USTAR timestamp field')
  })
})

describe('release artifact verification', () => {
  const projectRoots = new Map<string, string>()

  function buildValidSet() {
    const outputDirectory = temporaryDirectory(
      'branch-deploy-artifacts-verifier-'
    )
    const projectRoot = createProjectFixture()
    buildReleaseArtifacts({
      projectRoot,
      outputDirectory,
      version: 'v11.1.6',
      sourceSha: SOURCE_SHA,
      treeSha: TREE_SHA,
      previousStableTag: 'v11.1.2',
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      spdxInput: npmSpdxInput('v11.1.6'),
      toolVersions: TOOL_VERSIONS
    })
    projectRoots.set(outputDirectory, projectRoot)
    return outputDirectory
  }

  function verify(outputDirectory: string) {
    const projectRoot = projectRoots.get(outputDirectory)
    if (projectRoot === undefined) throw new TypeError('missing project root')
    return verifyReleaseArtifacts({
      outputDirectory,
      projectRoot,
      version: 'v11.1.6',
      sourceSha: SOURCE_SHA,
      treeSha: TREE_SHA
    })
  }

  function expectManifestRejection(
    mutate: (manifest: Record<string, unknown>) => void,
    message: string
  ): void {
    const outputDirectory = buildValidSet()
    const {manifest} = artifactFileNames('v11.1.6')
    mutateJsonArtifact(outputDirectory, manifest, mutate)
    rewriteChecksums(outputDirectory, 'v11.1.6')
    expect(() => verify(outputDirectory)).toThrow(message)
  }

  test('rejects malformed and ambiguous checksum manifests', () => {
    for (const {content, message} of [
      {content: 'invalid\n', message: 'Invalid checksum line'},
      {content: 'a'.repeat(64), message: 'must end with a newline'}
    ]) {
      const outputDirectory = buildValidSet()
      writeFileSync(resolve(outputDirectory, 'SHA256SUMS'), content)
      expect(() => verify(outputDirectory)).toThrow(message)
    }

    const duplicateDirectory = buildValidSet()
    const checksumsPath = resolve(duplicateDirectory, 'SHA256SUMS')
    const firstLine = readFileSync(checksumsPath, 'utf8').split('\n')[0]
    if (firstLine === undefined) throw new TypeError('missing checksum line')
    writeFileSync(
      checksumsPath,
      `${readFileSync(checksumsPath, 'utf8')}${firstLine}\n`
    )
    expect(() => verify(duplicateDirectory)).toThrow('Duplicate checksum entry')

    const wrongSetDirectory = buildValidSet()
    const lines = readFileSync(
      resolve(wrongSetDirectory, 'SHA256SUMS'),
      'utf8'
    ).split('\n')
    lines[2] = `${'a'.repeat(64)}  unexpected`
    writeFileSync(resolve(wrongSetDirectory, 'SHA256SUMS'), lines.join('\n'))
    expect(() => verify(wrongSetDirectory)).toThrow(
      'exact release artifact set'
    )

    const mismatchDirectory = buildValidSet()
    const mismatchPath = resolve(mismatchDirectory, 'SHA256SUMS')
    const mismatchContent = readFileSync(mismatchPath, 'utf8')
    writeFileSync(
      mismatchPath,
      `${mismatchContent.startsWith('0') ? '1' : '0'}${mismatchContent.slice(1)}`
    )
    expect(() => verify(mismatchDirectory)).toThrow('Checksum mismatch')
  })

  test('rejects malformed release manifest structures and identities', () => {
    for (const injectDuplicate of [
      (content: string) => content.replace('{', '{"sch\\u0065maVersion":1,'),
      (content: string) =>
        content.replace('"source": {', `"source": {"sha":"${SOURCE_SHA}",`)
    ]) {
      const outputDirectory = buildValidSet()
      const manifestName = artifactFileNames('v11.1.6').manifest
      const manifestPath = resolve(outputDirectory, manifestName)
      writeFileSync(
        manifestPath,
        injectDuplicate(readFileSync(manifestPath, 'utf8'))
      )
      rewriteChecksums(outputDirectory, 'v11.1.6')
      expect(() => verify(outputDirectory)).toThrow('Duplicate JSON object key')
    }

    expectManifestRejection(manifest => {
      manifest['unexpected'] = true
    }, 'unexpected or missing fields')
    expectManifestRejection(manifest => {
      manifest['schemaVersion'] = 2
    }, 'schemaVersion must be 1')
    expectManifestRejection(manifest => {
      manifest['version'] = 'v11.1.7'
    }, 'version does not match')
    expectManifestRejection(manifest => {
      manifest['previousStableTag'] = 'v11.1.5-rc.1'
    }, 'previousStableTag is invalid')
    expectManifestRejection(manifest => {
      manifest['previousStableTag'] = 'v11.1.6'
    }, 'previousStableTag is invalid')
    expectManifestRejection(manifest => {
      requireRecord(manifest['source'], 'source')['extra'] = true
    }, 'release source contains unexpected')
    expectManifestRejection(manifest => {
      requireRecord(manifest['source'], 'source')['sha'] = 'c'.repeat(40)
    }, 'source identity does not match')
    expectManifestRejection(manifest => {
      requireRecord(manifest['source'], 'source')['sourceDateEpoch'] = -1
    }, 'non-negative safe integer')
    expectManifestRejection(manifest => {
      requireRecord(manifest['source'], 'source')['sourceDateEpoch'] =
        0o100000000000
    }, 'USTAR timestamp field')
    expectManifestRejection(manifest => {
      requireRecord(manifest['tools'], 'tools')['extra'] = true
    }, 'release tools contains unexpected')
    expectManifestRejection(manifest => {
      requireRecord(manifest['tools'], 'tools')['npm'] = ''
    }, 'release tool npm must not be empty')
    expectManifestRejection(manifest => {
      requireRecord(manifest['tools'], 'tools')['npm'] = '0.0.0'
    }, 'Release manifest tool npm does not match')
    expectManifestRejection(manifest => {
      requireRecord(manifest['lockfile'], 'lockfile')['extra'] = true
    }, 'release lockfile contains unexpected')
    expectManifestRejection(manifest => {
      requireRecord(manifest['lockfile'], 'lockfile')['name'] = 'wrong'
    }, 'release lockfile name does not match')
    expectManifestRejection(manifest => {
      requireRecord(manifest['lockfile'], 'lockfile')['sha256'] = 'invalid'
    }, 'lowercase SHA-256')
    expectManifestRejection(manifest => {
      requireRecord(manifest['lockfile'], 'lockfile')['size'] = 'invalid'
    }, 'non-negative safe integer')
    expectManifestRejection(manifest => {
      requireRecord(manifest['lockfile'], 'lockfile')['sha256'] = '0'.repeat(64)
    }, 'lockfile metadata does not match source')
    expectManifestRejection(manifest => {
      requireRecord(manifest['lockfile'], 'lockfile')['size'] = 0
    }, 'lockfile metadata does not match source')
    expectManifestRejection(manifest => {
      requireRecord(manifest['artifacts'], 'artifacts')['extra'] = true
    }, 'release artifacts contains unexpected')
    expectManifestRejection(manifest => {
      const artifacts = requireRecord(manifest['artifacts'], 'artifacts')
      requireRecord(artifacts['archive'], 'archive')['name'] = 'wrong'
    }, 'archive metadata name does not match')
    expectManifestRejection(manifest => {
      const artifacts = requireRecord(manifest['artifacts'], 'artifacts')
      requireRecord(artifacts['archive'], 'archive')['sha256'] = '0'.repeat(64)
    }, 'artifact metadata does not match')
    expectManifestRejection(manifest => {
      const files = requireRecord(manifest['files'], 'files')
      files['unexpected'] = {sha256: '0'.repeat(64), size: 0}
    }, 'release files contains unexpected')
    expectManifestRejection(manifest => {
      const files = requireRecord(manifest['files'], 'files')
      requireRecord(files['action.yml'], 'action.yml')['extra'] = true
    }, 'release file metadata for action.yml contains unexpected')
    expectManifestRejection(manifest => {
      const files = requireRecord(manifest['files'], 'files')
      requireRecord(files['action.yml'], 'action.yml')['size'] = 0
    }, 'Release file metadata does not match action.yml')

    const invalidJsonDirectory = buildValidSet()
    const manifestName = artifactFileNames('v11.1.6').manifest
    writeFileSync(resolve(invalidJsonDirectory, manifestName), '{')
    rewriteChecksums(invalidJsonDirectory, 'v11.1.6')
    expect(() => verify(invalidJsonDirectory)).toThrow('Unable to parse')

    const arrayManifestDirectory = buildValidSet()
    writeFileSync(resolve(arrayManifestDirectory, manifestName), '[]\n')
    rewriteChecksums(arrayManifestDirectory, 'v11.1.6')
    expect(() => verify(arrayManifestDirectory)).toThrow(
      'must be a JSON object'
    )
  })

  test('rejects SBOM and artifact content inconsistent with the manifest', () => {
    const duplicateSbomDirectory = buildValidSet()
    const duplicateSbomName = artifactFileNames('v11.1.6').sbom
    const duplicateSbomPath = resolve(duplicateSbomDirectory, duplicateSbomName)
    writeFileSync(
      duplicateSbomPath,
      readFileSync(duplicateSbomPath, 'utf8').replace(
        '{',
        '{"spdxV\\u0065rsion":"SPDX-2.3",'
      )
    )
    refreshManifestArtifactMetadata(duplicateSbomDirectory, 'v11.1.6', 'sbom')
    rewriteChecksums(duplicateSbomDirectory, 'v11.1.6')
    expect(() => verify(duplicateSbomDirectory)).toThrow(
      'Duplicate JSON object key'
    )

    const sbomDirectory = buildValidSet()
    const sbomName = artifactFileNames('v11.1.6').sbom
    mutateJsonArtifact(sbomDirectory, sbomName, sbom => {
      sbom['documentNamespace'] = 'https://example.invalid'
    })
    refreshManifestArtifactMetadata(sbomDirectory, 'v11.1.6', 'sbom')
    rewriteChecksums(sbomDirectory, 'v11.1.6')
    expect(() => verify(sbomDirectory)).toThrow('namespace does not match')

    const archiveDirectory = buildValidSet()
    const archiveName = artifactFileNames('v11.1.6').archive
    writeFileSync(resolve(archiveDirectory, archiveName), 'tampered')
    rewriteChecksums(archiveDirectory, 'v11.1.6')
    expect(() => verify(archiveDirectory)).toThrow(
      'artifact metadata does not match'
    )
  })
})

describe('workflow CLI', () => {
  test('describes and validates release versions with workflow outputs', () => {
    const outputPath = resolve(
      temporaryDirectory('branch-deploy-artifacts-cli-'),
      'github-output'
    )
    const script = resolve('script/release-artifacts.ts')
    const described = spawnSync(
      process.execPath,
      [script, 'describe', '--version', 'v11.1.6-rc.1'],
      {encoding: 'utf8'}
    )
    const validated = spawnSync(
      process.execPath,
      [
        script,
        'validate',
        '--previous',
        'v11.1.5',
        '--next',
        'v11.1.6-rc.1',
        '--output',
        outputPath
      ],
      {encoding: 'utf8'}
    )

    expect(described.status, described.stderr).toBe(0)
    expect(load(described.stdout)).toMatchObject({
      version: 'v11.1.6-rc.1',
      prerelease: 'true',
      latest: 'false',
      update_major: 'false',
      major_tag: 'v11'
    })
    expect(validated.status, validated.stderr).toBe(0)
    expect(readFileSync(outputPath, 'utf8')).toContain(
      'previous_version=v11.1.5'
    )

    const stdout: string[] = []
    runReleaseArtifactsCli(
      ['validate', '--previous', 'v11.1.5'],
      'v11.1.6-rc.1',
      {cwd: process.cwd(), writeStdout: value => stdout.push(value)}
    )
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      previous_version: 'v11.1.5',
      version: 'v11.1.6-rc.1'
    })

    runReleaseArtifactsCli(
      [
        'validate',
        '--previous',
        'v11.1.5',
        '--next',
        'v11.1.6',
        '--output',
        outputPath
      ],
      'unused',
      {cwd: process.cwd(), writeStdout: value => stdout.push(value)}
    )
    expect(readFileSync(outputPath, 'utf8')).toContain('version=v11.1.6')
  })

  test('builds and verifies through the strict CLI contract', () => {
    const outputDirectory = temporaryDirectory('branch-deploy-cli-build-')
    const workflowOutput = resolve(
      temporaryDirectory('branch-deploy-cli-output-'),
      'github-output'
    )
    const stdout: string[] = []
    const io = {
      cwd: process.cwd(),
      writeStdout: (value: string) => stdout.push(value)
    }
    runReleaseArtifactsCli(
      [
        'build',
        '--version',
        'v11.1.6-rc.1',
        '--source-sha',
        SOURCE_SHA,
        '--tree-sha',
        TREE_SHA,
        '--previous-stable-tag',
        'v11.1.2',
        '--source-date-epoch',
        String(SOURCE_DATE_EPOCH),
        '--output-dir',
        outputDirectory,
        '--output',
        workflowOutput
      ],
      'unused',
      io
    )
    expect(readFileSync(workflowOutput, 'utf8')).toContain(
      'subject_paths<<__BRANCH_DEPLOY_RELEASE_OUTPUT__'
    )

    runReleaseArtifactsCli(
      [
        'verify',
        '--version',
        'v11.1.6-rc.1',
        '--source-sha',
        SOURCE_SHA,
        '--tree-sha',
        TREE_SHA,
        '--output-dir',
        outputDirectory,
        '--output',
        workflowOutput
      ],
      'unused',
      io
    )
    expect(stdout.join('')).toContain('archive_sha256')

    runReleaseArtifactsCli(
      [
        'verify',
        '--project-root',
        resolve('.'),
        '--version',
        'v11.1.6-rc.1',
        '--source-sha',
        SOURCE_SHA,
        '--tree-sha',
        TREE_SHA,
        '--output-dir',
        outputDirectory
      ],
      'unused',
      io
    )
  })

  test('rejects unknown, duplicate, incomplete, and unsafe CLI arguments', () => {
    const io = {cwd: process.cwd(), writeStdout: () => undefined}
    const cases: readonly {
      readonly argv: readonly string[]
      readonly error: string
    }[] = [
      {argv: [], error: 'Expected a command'},
      {argv: ['unknown'], error: 'Unknown command'},
      {argv: ['describe', 'version', 'v11.1.6'], error: '--name value pairs'},
      {
        argv: ['describe', '--unknown', 'value'],
        error: 'Unknown flag for describe'
      },
      {
        argv: ['describe', '--version', 'v11.1.6', '--version', 'v11.1.7'],
        error: 'Duplicate CLI flag'
      },
      {argv: ['describe'], error: 'Missing required flag: --version'},
      {
        argv: [
          'build',
          '--output-dir',
          'out',
          '--version',
          'v11.1.6',
          '--source-sha',
          SOURCE_SHA,
          '--tree-sha',
          TREE_SHA,
          '--previous-stable-tag',
          'v11.1.2',
          '--source-date-epoch',
          'invalid'
        ],
        error: 'must be an integer'
      }
    ]
    for (const {argv, error} of cases) {
      expect(() => {
        runReleaseArtifactsCli(argv, 'v11.1.6', io)
      }).toThrow(error)
    }

    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    runReleaseArtifactsCli(['describe', '--version', 'v11.1.6'], 'unused')
    expect(stdout).toHaveBeenCalled()
    stdout.mockRestore()
  })

  test('rejects workflow-output delimiter injection through paths', () => {
    const directory = temporaryDirectory(
      '__BRANCH_DEPLOY_RELEASE_OUTPUT__-project-'
    )
    const linkedProject = resolve(directory, 'project')
    symlinkSync(resolve('.'), linkedProject, 'dir')
    const outputDirectory = temporaryDirectory('branch-deploy-cli-delimiter-')
    const workflowOutput = resolve(directory, 'github-output')
    expect(() => {
      runReleaseArtifactsCli(
        [
          'build',
          '--project-root',
          linkedProject,
          '--version',
          'v11.1.6-rc.1',
          '--source-sha',
          SOURCE_SHA,
          '--tree-sha',
          TREE_SHA,
          '--previous-stable-tag',
          'v11.1.2',
          '--source-date-epoch',
          String(SOURCE_DATE_EPOCH),
          '--output-dir',
          outputDirectory,
          '--output',
          workflowOutput
        ],
        'unused',
        {cwd: process.cwd(), writeStdout: () => undefined}
      )
    }).toThrow('contains its delimiter')
  })
})
