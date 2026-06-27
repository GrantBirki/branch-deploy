import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, relative, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {gunzipSync, gzipSync, inflateRawSync} from 'node:zlib'
import {
  createReleasePolicy,
  compareReleaseVersions,
  parseReleaseVersion,
  validateVersionTransition,
  type ReleasePolicy
} from './release-policy.ts'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const RELEASE_DIST_FILES = [
  'index.js',
  'index.js.map',
  'licenses.txt',
  'package.json',
  'sourcemap-register.cjs',
  'sourcemap-register.js'
] as const
export const RELEASE_ACTION_FILES = [
  'action.yml',
  'dist/index.js',
  'dist/index.js.map',
  'dist/licenses.txt',
  'dist/package.json',
  'dist/sourcemap-register.cjs',
  'dist/sourcemap-register.js'
] as const

type JsonPrimitive = boolean | number | string | null
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
interface JsonObject {
  readonly [key: string]: JsonValue
}

interface ToolVersions {
  readonly node: string
  readonly npm: string
  readonly ncc: string
}

export interface BuildReleaseArtifactsOptions {
  readonly projectRoot: string
  readonly outputDirectory: string
  readonly version: string
  readonly sourceSha: string
  readonly treeSha: string
  readonly previousStableTag: string
  readonly sourceDateEpoch: number
  readonly spdxInput?: unknown
  readonly toolVersions?: ToolVersions
}

export interface ReleaseArtifactPaths {
  readonly version: string
  readonly archivePath: string
  readonly sbomPath: string
  readonly manifestPath: string
  readonly checksumsPath: string
  readonly provenanceBundleName: string
  readonly sbomBundleName: string
  readonly subjectPaths: readonly string[]
}

export interface VerifyReleaseArtifactsOptions {
  readonly outputDirectory: string
  readonly projectRoot?: string
  readonly version: string
  readonly sourceSha: string
  readonly treeSha: string
}

export interface VerifiedReleaseArtifacts {
  readonly version: string
  readonly archiveSha256: string
  readonly sbomSha256: string
  readonly manifestSha256: string
  readonly archivedFiles: readonly string[]
}

interface TarEntry {
  readonly name: string
  readonly content: Buffer
  readonly mode: number
  readonly type: '0' | '5'
}

interface TarLayoutEntry {
  readonly name: string
  readonly mode: number
  readonly type: '0' | '5'
  readonly sourcePath?: (typeof RELEASE_ACTION_FILES)[number]
}

type ReleaseActionFile = (typeof RELEASE_ACTION_FILES)[number]
interface ActionFileContents {
  readonly 'action.yml': Buffer
  readonly 'dist/index.js': Buffer
  readonly 'dist/index.js.map': Buffer
  readonly 'dist/licenses.txt': Buffer
  readonly 'dist/package.json': Buffer
  readonly 'dist/sourcemap-register.cjs': Buffer
  readonly 'dist/sourcemap-register.js': Buffer
}

function toJsonValue(value: unknown, location = 'JSON value'): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${location} contains a non-finite number.`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      toJsonValue(item, `${location}[${index}]`)
    )
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        toJsonValue(item, `${location}.${key}`)
      ])
    )
  }
  throw new Error(`${location} is not valid JSON.`)
}

function expectJsonObject(
  value: JsonValue | undefined,
  location: string
): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${location} must be a JSON object.`)
  }
  return Object.fromEntries(Object.entries(value))
}

function expectString(value: JsonValue | undefined, location: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${location} must be a string.`)
  }
  return value
}

function expectNonEmptyString(
  value: JsonValue | undefined,
  location: string
): string {
  const result = expectString(value, location)
  if (result.length === 0) throw new Error(`${location} must not be empty.`)
  return result
}

function expectInteger(value: JsonValue | undefined, location: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${location} must be a non-negative safe integer.`)
  }
  return value
}

function expectArray(
  value: JsonValue | undefined,
  location: string
): readonly JsonValue[] {
  if (!isJsonArray(value)) throw new Error(`${location} must be an array.`)
  return value
}

function requireExactKeys(
  value: JsonObject,
  expectedKeys: readonly string[],
  location: string
): void {
  const actual = Object.keys(value).sort(compareText)
  const expected = [...expectedKeys].sort(compareText)
  if (compactJson(actual) !== compactJson(expected)) {
    throw new Error(`${location} contains unexpected or missing fields.`)
  }
}

function expectSha256(value: JsonValue | undefined, location: string): string {
  const result = expectString(value, location)
  if (!/^[0-9a-f]{64}$/.test(result)) {
    throw new Error(`${location} must be a lowercase SHA-256 digest.`)
  }
  return result
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function compactJson(value: JsonValue): string {
  return JSON.stringify(value)
}

function isJsonArray(
  value: JsonValue | undefined
): value is readonly JsonValue[] {
  return Array.isArray(value)
}

function canonicalizeJson(value: JsonValue): JsonValue {
  if (isJsonArray(value)) {
    return value
      .map(item => canonicalizeJson(item))
      .sort((left, right) => compareText(compactJson(left), compactJson(right)))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, canonicalizeJson(item)])
    )
  }
  return value
}

function serializeJson(value: JsonValue): string {
  return `${JSON.stringify(canonicalizeJson(value), null, 2)}\n`
}

interface JsonScanner {
  readonly text: string
  index: number
}

function skipJsonWhitespace(scanner: JsonScanner): void {
  while (/\s/u.test(scanner.text[scanner.index] ?? '')) scanner.index += 1
}

function scanJsonString(scanner: JsonScanner): string {
  const start = scanner.index
  scanner.index += 1
  while (scanner.index < scanner.text.length) {
    const character = scanner.text.charAt(scanner.index)
    scanner.index += 1
    if (character === '"') {
      const decoded: unknown = JSON.parse(
        scanner.text.slice(start, scanner.index)
      )
      return String(decoded)
    }
    if (character === '\\') {
      const escape = scanner.text.charAt(scanner.index)
      scanner.index += 1
      if (escape === 'u') {
        const digits = scanner.text.slice(scanner.index, scanner.index + 4)
        if (!/^[0-9a-f]{4}$/iu.test(digits)) {
          throw new SyntaxError('Invalid JSON Unicode escape.')
        }
        scanner.index += 4
      } else if (!/["\\/bfnrt]/u.test(escape)) {
        throw new SyntaxError('Invalid JSON string escape.')
      }
    } else if (character.charCodeAt(0) < 0x20) {
      throw new SyntaxError('Invalid JSON string character.')
    }
  }
  throw new SyntaxError('Unterminated JSON string.')
}

function scanJsonLiteral(scanner: JsonScanner, literal: string): void {
  if (!scanner.text.startsWith(literal, scanner.index)) {
    throw new SyntaxError(`Invalid JSON token at offset ${scanner.index}.`)
  }
  scanner.index += literal.length
}

function scanJsonNumber(scanner: JsonScanner): void {
  const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
    scanner.text.slice(scanner.index)
  )
  if (match === null) {
    throw new SyntaxError(`Invalid JSON number at offset ${scanner.index}.`)
  }
  scanner.index += match[0].length
}

function scanJsonArray(scanner: JsonScanner): void {
  scanner.index += 1
  skipJsonWhitespace(scanner)
  if (scanner.text[scanner.index] === ']') {
    scanner.index += 1
    return
  }
  while (scanner.index < scanner.text.length) {
    scanJsonValue(scanner)
    skipJsonWhitespace(scanner)
    if (scanner.text[scanner.index] === ']') {
      scanner.index += 1
      return
    }
    if (scanner.text[scanner.index] !== ',') {
      throw new SyntaxError(
        `Expected a JSON array separator at offset ${scanner.index}.`
      )
    }
    scanner.index += 1
    skipJsonWhitespace(scanner)
  }
  throw new SyntaxError('Unterminated JSON array.')
}

function scanJsonObject(scanner: JsonScanner): void {
  scanner.index += 1
  skipJsonWhitespace(scanner)
  if (scanner.text[scanner.index] === '}') {
    scanner.index += 1
    return
  }
  const keys = new Set<string>()
  while (scanner.index < scanner.text.length) {
    if (scanner.text[scanner.index] !== '"') {
      throw new SyntaxError(
        `Expected a JSON object key at offset ${scanner.index}.`
      )
    }
    const key = scanJsonString(scanner)
    if (keys.has(key))
      throw new SyntaxError(`Duplicate JSON object key: ${key}`)
    keys.add(key)
    skipJsonWhitespace(scanner)
    if (scanner.text[scanner.index] !== ':') {
      throw new SyntaxError(
        `Expected a JSON object colon at offset ${scanner.index}.`
      )
    }
    scanner.index += 1
    scanJsonValue(scanner)
    skipJsonWhitespace(scanner)
    if (scanner.text[scanner.index] === '}') {
      scanner.index += 1
      return
    }
    if (scanner.text[scanner.index] !== ',') {
      throw new SyntaxError(
        `Expected a JSON object separator at offset ${scanner.index}.`
      )
    }
    scanner.index += 1
    skipJsonWhitespace(scanner)
  }
  throw new SyntaxError('Unterminated JSON object.')
}

function scanJsonValue(scanner: JsonScanner): void {
  skipJsonWhitespace(scanner)
  switch (scanner.text[scanner.index]) {
    case '{':
      scanJsonObject(scanner)
      return
    case '[':
      scanJsonArray(scanner)
      return
    case '"':
      scanJsonString(scanner)
      return
    case 't':
      scanJsonLiteral(scanner, 'true')
      return
    case 'f':
      scanJsonLiteral(scanner, 'false')
      return
    case 'n':
      scanJsonLiteral(scanner, 'null')
      return
    default:
      scanJsonNumber(scanner)
  }
}

export function parseReleaseJson(text: string, location: string): JsonValue {
  try {
    const scanner: JsonScanner = {text, index: 0}
    scanJsonValue(scanner)
    skipJsonWhitespace(scanner)
    if (scanner.index !== text.length) {
      throw new SyntaxError(
        `Unexpected JSON content at offset ${scanner.index}.`
      )
    }
    return toJsonValue(JSON.parse(text), location)
  } catch (error) {
    throw new Error(`Unable to parse ${location}: ${String(error)}`)
  }
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function requireSafeEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o77777777777) {
    throw new Error(
      'sourceDateEpoch must fit the non-negative USTAR timestamp field.'
    )
  }
}

function requireSha(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character Git SHA.`)
  }
}

function normalizedPath(path: string): string {
  return path.split(sep).join('/')
}

function writeTarString(
  header: Buffer,
  value: string,
  offset: number,
  length: number
): void {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.length > length) {
    throw new Error(`Tar entry value is too long: ${value}`)
  }
  encoded.copy(header, offset)
}

function writeTarOctal(
  header: Buffer,
  value: number,
  offset: number,
  length: number
): void {
  const octal = value.toString(8).padStart(length - 1, '0')
  writeTarString(header, `${octal}\0`, offset, length)
}

function createTarHeader(entry: TarEntry, sourceDateEpoch: number): Buffer {
  const header = Buffer.alloc(512)
  writeTarString(header, entry.name, 0, 100)
  writeTarOctal(header, entry.mode, 100, 8)
  writeTarOctal(header, 0, 108, 8)
  writeTarOctal(header, 0, 116, 8)
  writeTarOctal(header, entry.content.length, 124, 12)
  writeTarOctal(header, sourceDateEpoch, 136, 12)
  header.fill(0x20, 148, 156)
  writeTarString(header, entry.type, 156, 1)
  writeTarString(header, 'ustar\0', 257, 6)
  writeTarString(header, '00', 263, 2)

  let checksum = 0
  for (const byte of header) checksum += byte
  const checksumText = checksum.toString(8).padStart(6, '0')
  writeTarString(header, `${checksumText}\0 `, 148, 8)
  return header
}

function createTar(
  entries: readonly TarEntry[],
  sourceDateEpoch: number
): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    chunks.push(createTarHeader(entry, sourceDateEpoch), entry.content)
    const remainder = entry.content.length % 512
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function createDeterministicGzip(content: Buffer): Buffer {
  const gzip = gzipSync(content, {level: 9})
  gzip.fill(0, 4, 8)
  gzip[9] = 0xff
  return gzip
}

function readRegularFile(projectRoot: string, path: ReleaseActionFile): Buffer {
  const absolutePath = resolve(projectRoot, path)
  if (!lstatSync(absolutePath).isFile()) {
    throw new Error(`Release input must be a regular file: ${path}`)
  }
  return readFileSync(absolutePath)
}

function readActionFiles(projectRoot: string): ActionFileContents {
  const distDirectory = resolve(projectRoot, 'dist')
  const actualDistFiles = readdirSync(distDirectory).sort(compareText)
  if (compactJson(actualDistFiles) !== compactJson([...RELEASE_DIST_FILES])) {
    throw new Error(
      `dist must contain exactly: ${RELEASE_DIST_FILES.join(', ')}. Found: ${actualDistFiles.join(', ')}.`
    )
  }

  return {
    'action.yml': readRegularFile(projectRoot, 'action.yml'),
    'dist/index.js': readRegularFile(projectRoot, 'dist/index.js'),
    'dist/index.js.map': readRegularFile(projectRoot, 'dist/index.js.map'),
    'dist/licenses.txt': readRegularFile(projectRoot, 'dist/licenses.txt'),
    'dist/package.json': readRegularFile(projectRoot, 'dist/package.json'),
    'dist/sourcemap-register.cjs': readRegularFile(
      projectRoot,
      'dist/sourcemap-register.cjs'
    ),
    'dist/sourcemap-register.js': readRegularFile(
      projectRoot,
      'dist/sourcemap-register.js'
    )
  }
}

function actionArchiveLayout(policy: ReleasePolicy): readonly TarLayoutEntry[] {
  const root = `${policy.assetPrefix}/`
  return [
    {name: root, mode: 0o755, type: '5' as const},
    {name: `${root}dist/`, mode: 0o755, type: '5' as const},
    ...RELEASE_ACTION_FILES.map(sourcePath => ({
      name: `${root}${sourcePath}`,
      mode: 0o644,
      type: '0' as const,
      sourcePath
    }))
  ].sort((left, right) => compareText(left.name, right.name))
}

function createActionArchive(
  files: ActionFileContents,
  policy: ReleasePolicy,
  sourceDateEpoch: number
): Buffer {
  const entries: TarEntry[] = actionArchiveLayout(policy).map(entry => ({
    name: entry.name,
    content:
      entry.sourcePath === undefined
        ? Buffer.alloc(0)
        : files[entry.sourcePath],
    mode: entry.mode,
    type: entry.type
  }))
  return createDeterministicGzip(createTar(entries, sourceDateEpoch))
}

function packageVersion(version: string): string {
  return version.slice(1)
}

function withRootPackageVersion(
  input: JsonValue,
  version: string,
  isLockfile: boolean
): JsonObject {
  const root = expectJsonObject(input, 'package metadata')
  const result: Record<string, JsonValue> = {...root, version}

  if (isLockfile) {
    const packages = expectJsonObject(root['packages'], 'package-lock packages')
    const rootPackage = expectJsonObject(
      packages[''],
      'package-lock root package'
    )
    result['packages'] = {
      ...packages,
      '': {...rootPackage, version}
    }
  }
  return result
}

let cachedNpmVersion: string | undefined

function readNpmVersion(): string {
  cachedNpmVersion ??= execFileSync('npm', ['--version'], {
    encoding: 'utf8'
  }).trim()
  return cachedNpmVersion
}

function generateNpmSpdx(
  projectRoot: string,
  version: string
): {readonly document: JsonValue; readonly npmVersion: string} {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'branch-deploy-sbom-'))
  try {
    const npmVersion = readNpmVersion()
    for (const [file, isLockfile] of [
      ['package.json', false],
      ['package-lock.json', true]
    ] as const) {
      const input = parseReleaseJson(
        readFileSync(resolve(projectRoot, file), 'utf8'),
        file
      )
      writeFileSync(
        resolve(temporaryDirectory, file),
        serializeJson(
          withRootPackageVersion(input, packageVersion(version), isLockfile)
        )
      )
    }

    const output = execFileSync(
      'npm',
      [
        'sbom',
        '--package-lock-only',
        '--sbom-format',
        'spdx',
        '--sbom-type',
        'application',
        '--omit=dev'
      ],
      {cwd: temporaryDirectory, encoding: 'utf8'}
    )
    return {document: parseReleaseJson(output, 'npm SPDX output'), npmVersion}
  } finally {
    rmSync(temporaryDirectory, {recursive: true, force: true})
  }
}

export function normalizeSpdxDocument(
  input: unknown,
  version: string,
  sourceSha: string,
  sourceDateEpoch: number
): JsonObject {
  const policy = createReleasePolicy(version)
  requireSha(sourceSha, 'sourceSha')
  requireSafeEpoch(sourceDateEpoch)
  const document = expectJsonObject(toJsonValue(input, 'SPDX document'), 'SPDX')
  if (document['spdxVersion'] !== 'SPDX-2.3') {
    throw new Error('npm SPDX document must use SPDX-2.3.')
  }
  if (!Array.isArray(document['packages'])) {
    throw new Error('npm SPDX document must contain a packages array.')
  }
  const creationInfo = expectJsonObject(
    document['creationInfo'],
    'SPDX creationInfo'
  )
  const normalized = canonicalizeJson({
    ...document,
    name: `${policy.assetPrefix} action bundle`,
    documentNamespace: `https://github.com/GrantBirki/branch-deploy/sbom/${policy.version}/${sourceSha}`,
    creationInfo: {
      ...creationInfo,
      created: new Date(sourceDateEpoch * 1000).toISOString()
    }
  })
  const result = expectJsonObject(normalized, 'normalized SPDX document')
  validateReleaseSpdxDocument(
    result,
    policy.version,
    sourceSha,
    sourceDateEpoch
  )
  return result
}

export function validateReleaseSpdxDocument(
  input: unknown,
  version: string,
  sourceSha: string,
  sourceDateEpoch: number
): void {
  const policy = createReleasePolicy(version)
  requireSha(sourceSha, 'sourceSha')
  requireSafeEpoch(sourceDateEpoch)
  const document = expectJsonObject(
    toJsonValue(input, 'SPDX document'),
    'SPDX document'
  )
  if (document['spdxVersion'] !== 'SPDX-2.3') {
    throw new Error('SPDX release document must use SPDX-2.3.')
  }
  if (document['SPDXID'] !== 'SPDXRef-DOCUMENT') {
    throw new Error('SPDX document must use SPDXRef-DOCUMENT.')
  }
  if (document['dataLicense'] !== 'CC0-1.0') {
    throw new Error('SPDX document must use the CC0-1.0 data license.')
  }
  if (document['name'] !== `${policy.assetPrefix} action bundle`) {
    throw new Error('SPDX document name does not match the release.')
  }
  const expectedNamespace = `https://github.com/GrantBirki/branch-deploy/sbom/${policy.version}/${sourceSha}`
  if (document['documentNamespace'] !== expectedNamespace) {
    throw new Error('SPDX document namespace does not match the release.')
  }

  const creationInfo = expectJsonObject(
    document['creationInfo'],
    'SPDX creationInfo'
  )
  if (
    creationInfo['created'] !== new Date(sourceDateEpoch * 1000).toISOString()
  ) {
    throw new Error('SPDX creation timestamp does not match the source epoch.')
  }
  const creators = expectArray(
    creationInfo['creators'],
    'SPDX creationInfo creators'
  )
  if (creators.length === 0) {
    throw new Error('SPDX creationInfo creators must not be empty.')
  }
  for (const [index, creator] of creators.entries()) {
    expectNonEmptyString(creator, `SPDX creator ${index}`)
  }

  const packages = expectArray(document['packages'], 'SPDX packages').map(
    (value, index) => expectJsonObject(value, `SPDX package ${index}`)
  )
  for (const [index, packageValue] of packages.entries()) {
    expectNonEmptyString(packageValue['SPDXID'], `SPDX package ${index} SPDXID`)
    expectNonEmptyString(packageValue['name'], `SPDX package ${index} name`)
    expectNonEmptyString(
      packageValue['downloadLocation'],
      `SPDX package ${index} downloadLocation`
    )
  }

  const rootPackages = packages.filter(
    packageValue => packageValue['name'] === 'branch-deploy'
  )
  if (rootPackages.length !== 1) {
    throw new Error('SPDX must describe exactly one branch-deploy package.')
  }
  const rootPackage = expectJsonObject(rootPackages[0], 'SPDX root package')
  const rootId = `SPDXRef-Package-branch-deploy-${packageVersion(policy.version)}`
  if (
    rootPackage['SPDXID'] !== rootId ||
    rootPackage['versionInfo'] !== packageVersion(policy.version) ||
    rootPackage['primaryPackagePurpose'] !== 'APPLICATION' ||
    rootPackage['filesAnalyzed'] !== false ||
    rootPackage['packageFileName'] !== ''
  ) {
    throw new Error('SPDX root package does not match the action release.')
  }

  const documentDescribes = expectArray(
    document['documentDescribes'],
    'SPDX documentDescribes'
  )
  if (compactJson(documentDescribes) !== compactJson([rootId])) {
    throw new Error('SPDX documentDescribes must identify the root package.')
  }
  const relationships = expectArray(
    document['relationships'],
    'SPDX relationships'
  ).map((value, index) => expectJsonObject(value, `SPDX relationship ${index}`))
  const describesRoot = relationships.some(
    relationship =>
      relationship['spdxElementId'] === 'SPDXRef-DOCUMENT' &&
      relationship['relationshipType'] === 'DESCRIBES' &&
      relationship['relatedSpdxElement'] === rootId
  )
  if (!describesRoot) {
    throw new Error('SPDX relationships must describe the root package.')
  }
}

function readNccVersion(projectRoot: string): string {
  const lockfile = expectJsonObject(
    parseReleaseJson(
      readFileSync(resolve(projectRoot, 'package-lock.json'), 'utf8'),
      'package-lock.json'
    ),
    'package-lock.json'
  )
  const packages = expectJsonObject(
    lockfile['packages'],
    'package-lock packages'
  )
  const ncc = expectJsonObject(
    packages['node_modules/@vercel/ncc'],
    'package-lock ncc package'
  )
  return expectString(ncc['version'], 'package-lock ncc version')
}

function fileMetadata(content: Buffer): JsonObject {
  return {sha256: sha256(content), size: content.length}
}

function artifactNames(policy: ReleasePolicy): {
  readonly archive: string
  readonly sbom: string
  readonly manifest: string
  readonly checksums: string
  readonly provenanceBundle: string
  readonly sbomBundle: string
} {
  return {
    archive: `${policy.assetPrefix}.tar.gz`,
    sbom: `${policy.assetPrefix}.spdx.json`,
    manifest: `${policy.assetPrefix}.release.json`,
    checksums: 'SHA256SUMS',
    provenanceBundle: `${policy.assetPrefix}.provenance.sigstore.jsonl`,
    sbomBundle: `${policy.assetPrefix}.sbom.sigstore.jsonl`
  }
}

function prepareOutputDirectory(outputDirectory: string): void {
  mkdirSync(outputDirectory, {recursive: true})
  const existing = readdirSync(outputDirectory)
  if (existing.length !== 0) {
    throw new Error('Release output directory must be empty.')
  }
}

export function buildReleaseArtifacts(
  options: BuildReleaseArtifactsOptions
): ReleaseArtifactPaths {
  const policy = createReleasePolicy(options.version)
  const previousStable = parseReleaseVersion(options.previousStableTag)
  if (previousStable.rc !== null) {
    throw new Error('previousStableTag must identify a stable release.')
  }
  if (
    compareReleaseVersions(
      previousStable,
      parseReleaseVersion(policy.version)
    ) >= 0
  ) {
    throw new Error('previousStableTag must precede the release version.')
  }
  requireSha(options.sourceSha, 'sourceSha')
  requireSha(options.treeSha, 'treeSha')
  requireSafeEpoch(options.sourceDateEpoch)
  prepareOutputDirectory(options.outputDirectory)

  const files = readActionFiles(options.projectRoot)
  const names = artifactNames(policy)
  const archive = createActionArchive(files, policy, options.sourceDateEpoch)

  const generatedSpdx =
    options.spdxInput === undefined
      ? generateNpmSpdx(options.projectRoot, policy.version)
      : {document: options.spdxInput, npmVersion: 'unknown'}
  const sbom = Buffer.from(
    serializeJson(
      normalizeSpdxDocument(
        generatedSpdx.document,
        policy.version,
        options.sourceSha,
        options.sourceDateEpoch
      )
    )
  )
  const tools = options.toolVersions ?? {
    node: process.version,
    npm: generatedSpdx.npmVersion,
    ncc: readNccVersion(options.projectRoot)
  }
  const fileManifest = Object.fromEntries(
    RELEASE_ACTION_FILES.map(path => [path, fileMetadata(files[path])])
  )
  const manifest = Buffer.from(
    serializeJson({
      schemaVersion: 1,
      version: policy.version,
      previousStableTag: previousStable.raw,
      source: {
        sha: options.sourceSha,
        tree: options.treeSha,
        sourceDateEpoch: options.sourceDateEpoch
      },
      tools: {node: tools.node, npm: tools.npm, ncc: tools.ncc},
      lockfile: {
        name: 'package-lock.json',
        ...fileMetadata(
          readFileSync(resolve(options.projectRoot, 'package-lock.json'))
        )
      },
      files: fileManifest,
      artifacts: {
        archive: {name: names.archive, ...fileMetadata(archive)},
        sbom: {name: names.sbom, ...fileMetadata(sbom)}
      }
    })
  )
  const checksums = Buffer.from(
    [
      `${sha256(archive)}  ${names.archive}`,
      `${sha256(sbom)}  ${names.sbom}`,
      `${sha256(manifest)}  ${names.manifest}`,
      ''
    ].join('\n')
  )

  const archivePath = resolve(options.outputDirectory, names.archive)
  const sbomPath = resolve(options.outputDirectory, names.sbom)
  const manifestPath = resolve(options.outputDirectory, names.manifest)
  const checksumsPath = resolve(options.outputDirectory, names.checksums)
  writeFileSync(archivePath, archive)
  writeFileSync(sbomPath, sbom)
  writeFileSync(manifestPath, manifest)
  writeFileSync(checksumsPath, checksums)

  return {
    version: policy.version,
    archivePath,
    sbomPath,
    manifestPath,
    checksumsPath,
    provenanceBundleName: names.provenanceBundle,
    sbomBundleName: names.sbomBundle,
    subjectPaths: [
      ...RELEASE_ACTION_FILES.map(path => resolve(options.projectRoot, path)),
      archivePath,
      sbomPath,
      manifestPath,
      checksumsPath
    ]
  }
}

function isZeroFilled(value: Buffer): boolean {
  return value.every(byte => byte === 0)
}

function readTarString(
  header: Buffer,
  offset: number,
  length: number,
  label: string
): string {
  const field = header.subarray(offset, offset + length)
  const terminator = field.indexOf(0)
  const end = terminator === -1 ? field.length : terminator
  if (terminator !== -1 && !isZeroFilled(field.subarray(terminator))) {
    throw new Error(`${label} has nonzero bytes after its terminator.`)
  }
  const encoded = field.subarray(0, end)
  const decoded = encoded.toString('utf8')
  if (!Buffer.from(decoded, 'utf8').equals(encoded)) {
    throw new Error(`${label} is not valid UTF-8.`)
  }
  return decoded
}

function readTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  label: string
): number {
  const field = header.subarray(offset, offset + length).toString('ascii')
  if (!/^[0-7]+\0$/.test(field)) {
    throw new Error(`${label} is not a canonical USTAR octal field.`)
  }
  const value = Number.parseInt(field.slice(0, -1), 8)
  return value
}

function requireZeroTarField(
  header: Buffer,
  offset: number,
  length: number,
  label: string
): void {
  if (!isZeroFilled(header.subarray(offset, offset + length))) {
    throw new Error(`${label} must be empty in the deterministic archive.`)
  }
}

function validateTarChecksum(header: Buffer, name: string): void {
  const checksumField = header.subarray(148, 156).toString('ascii')
  if (!/^[0-7]{6}\0 $/.test(checksumField)) {
    throw new Error(`Tar checksum field is malformed for ${name}.`)
  }
  const expected = Number.parseInt(checksumField.slice(0, 6), 8)
  let actual = 0
  for (const [index, byte] of header.entries()) {
    actual += index >= 148 && index < 156 ? 0x20 : byte
  }
  if (actual !== expected) {
    throw new Error(`Tar checksum mismatch for ${name}.`)
  }
}

function validateArchivePath(name: string): void {
  if (
    name.length === 0 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('//') ||
    name.split('/').some(part => part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe tar entry path: ${name}`)
  }
}

function validateGzipHeader(archive: Buffer): void {
  if (
    archive.length < 18 ||
    archive[0] !== 0x1f ||
    archive[1] !== 0x8b ||
    archive[2] !== 8 ||
    archive[3] !== 0 ||
    !isZeroFilled(archive.subarray(4, 8)) ||
    archive[8] !== 2 ||
    archive[9] !== 0xff
  ) {
    throw new Error('Archive does not use the deterministic gzip header.')
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireInflateBytesWritten(value: unknown): number {
  if (!isUnknownRecord(value)) {
    throw new Error('Raw inflate did not return engine metadata.')
  }
  const engine = value['engine']
  if (!isUnknownRecord(engine) || typeof engine['bytesWritten'] !== 'number') {
    throw new Error('Raw inflate did not return engine byte accounting.')
  }
  return engine['bytesWritten']
}

function gunzipSingleMember(archive: Buffer): Buffer {
  validateGzipHeader(archive)
  const inflated: unknown = inflateRawSync(archive.subarray(10), {info: true})
  const trailerEnd = 10 + requireInflateBytesWritten(inflated) + 8
  if (trailerEnd !== archive.length) {
    throw new Error('Archive must contain exactly one canonical gzip member.')
  }
  return gunzipSync(archive)
}

export function inspectReleaseArchive(
  archive: Buffer,
  version: string,
  sourceDateEpoch: number
): ReadonlyMap<string, Buffer> {
  const policy = createReleasePolicy(version)
  requireSafeEpoch(sourceDateEpoch)
  const tar = gunzipSingleMember(archive)
  if (tar.length % 512 !== 0) {
    throw new Error('USTAR payload length must be a multiple of 512 bytes.')
  }

  const expectedEntries = actionArchiveLayout(policy)
  const entries = new Map<string, Buffer>()
  let offset = 0
  let entryIndex = 0
  while (offset < tar.length) {
    if (offset + 1024 === tar.length) {
      if (!isZeroFilled(tar.subarray(offset))) {
        throw new Error('USTAR archive must end with two zero blocks.')
      }
      if (entryIndex !== expectedEntries.length) {
        throw new Error('Action archive is missing expected entries.')
      }
      return entries
    }
    if (offset + 1024 > tar.length) {
      throw new Error('USTAR archive is missing its two-block terminator.')
    }

    const header = tar.subarray(offset, offset + 512)
    if (isZeroFilled(header)) {
      throw new Error('USTAR archive contains a premature zero block.')
    }
    const name = readTarString(header, 0, 100, 'Tar entry name')
    validateArchivePath(name)
    validateTarChecksum(header, name)
    if (header.subarray(257, 263).toString('latin1') !== 'ustar\0') {
      throw new Error(`Tar entry does not use USTAR magic: ${name}`)
    }
    if (header.subarray(263, 265).toString('ascii') !== '00') {
      throw new Error(`Tar entry does not use USTAR version 00: ${name}`)
    }
    requireZeroTarField(header, 157, 100, 'Tar link name')
    requireZeroTarField(header, 265, 32, 'Tar owner name')
    requireZeroTarField(header, 297, 32, 'Tar group name')
    requireZeroTarField(header, 329, 8, 'Tar device major')
    requireZeroTarField(header, 337, 8, 'Tar device minor')
    requireZeroTarField(header, 345, 155, 'Tar path prefix')
    requireZeroTarField(header, 500, 12, 'Tar header padding')

    if (entries.has(name)) {
      throw new Error(`Action archive contains duplicate entry: ${name}`)
    }
    const expected = expectedEntries[entryIndex]
    if (expected?.name !== name) {
      throw new Error(`Action archive entry order or name is invalid: ${name}`)
    }

    const type = String.fromCharCode(header.readUInt8(156))
    if (type !== expected.type) {
      throw new Error(`Tar entry type is invalid for ${name}.`)
    }
    if (
      readTarOctal(header, 100, 8, `Tar mode for ${name}`) !== expected.mode
    ) {
      throw new Error(`Tar entry mode is invalid for ${name}.`)
    }
    if (
      readTarOctal(header, 108, 8, `Tar uid for ${name}`) !== 0 ||
      readTarOctal(header, 116, 8, `Tar gid for ${name}`) !== 0
    ) {
      throw new Error(`Tar entry ownership is invalid for ${name}.`)
    }
    const size = readTarOctal(header, 124, 12, `Tar size for ${name}`)
    if (expected.type === '5' && size !== 0) {
      throw new Error(`Tar directory entry has content: ${name}`)
    }
    if (
      readTarOctal(header, 136, 12, `Tar timestamp for ${name}`) !==
      sourceDateEpoch
    ) {
      throw new Error(`Tar entry timestamp is invalid for ${name}.`)
    }

    const contentStart = offset + 512
    const contentEnd = contentStart + size
    const paddedEnd = contentStart + Math.ceil(size / 512) * 512
    if (contentEnd > tar.length || paddedEnd > tar.length) {
      throw new Error(`Tar entry content exceeds the archive: ${name}`)
    }
    if (!isZeroFilled(tar.subarray(contentEnd, paddedEnd))) {
      throw new Error(`Tar entry padding is nonzero for ${name}.`)
    }
    entries.set(name, tar.subarray(contentStart, contentEnd))
    entryIndex += 1
    offset = paddedEnd
  }

  throw new Error('USTAR archive is missing its two-block terminator.')
}

function parseChecksumManifest(content: string): ReadonlyMap<string, string> {
  if (!content.endsWith('\n')) {
    throw new Error('SHA256SUMS must end with a newline.')
  }
  const checksums = new Map<string, string>()
  for (const line of content.slice(0, -1).split('\n')) {
    const match = /^([0-9a-f]{64}) {2}([^/]+)$/.exec(line)
    const digest = match?.[1]
    const name = match?.[2]
    if (digest === undefined || name === undefined) {
      throw new Error(`Invalid checksum line: ${line}`)
    }
    if (checksums.has(name)) {
      throw new Error(`Duplicate checksum entry: ${name}`)
    }
    checksums.set(name, digest)
  }
  return checksums
}

function verifyChecksum(
  checksums: ReadonlyMap<string, string>,
  name: string,
  content: Buffer
): string {
  const expected = checksums.get(name)
  if (expected === undefined || expected !== sha256(content)) {
    throw new Error(`Checksum mismatch for ${name}.`)
  }
  return expected
}

interface VerifiedFileMetadata {
  readonly sha256: string
  readonly size: number
}

function verifyFileMetadataShape(
  value: JsonValue | undefined,
  location: string
): VerifiedFileMetadata {
  const metadata = expectJsonObject(value, location)
  requireExactKeys(metadata, ['sha256', 'size'], location)
  return {
    sha256: expectSha256(metadata['sha256'], `${location} sha256`),
    size: expectInteger(metadata['size'], `${location} size`)
  }
}

function verifyArtifactMetadataShape(
  value: JsonValue | undefined,
  location: string,
  expectedName: string
): VerifiedFileMetadata {
  const metadata = expectJsonObject(value, location)
  requireExactKeys(metadata, ['name', 'sha256', 'size'], location)
  if (metadata['name'] !== expectedName) {
    throw new Error(`${location} name does not match.`)
  }
  return {
    sha256: expectSha256(metadata['sha256'], `${location} sha256`),
    size: expectInteger(metadata['size'], `${location} size`)
  }
}

export function verifyReleaseArtifacts(
  options: VerifyReleaseArtifactsOptions
): VerifiedReleaseArtifacts {
  const policy = createReleasePolicy(options.version)
  const projectRoot = options.projectRoot ?? PROJECT_ROOT
  requireSha(options.sourceSha, 'sourceSha')
  requireSha(options.treeSha, 'treeSha')
  const names = artifactNames(policy)
  const archive = readFileSync(resolve(options.outputDirectory, names.archive))
  const sbom = readFileSync(resolve(options.outputDirectory, names.sbom))
  const manifest = readFileSync(
    resolve(options.outputDirectory, names.manifest)
  )
  const checksums = parseChecksumManifest(
    readFileSync(resolve(options.outputDirectory, names.checksums), 'utf8')
  )
  const expectedChecksumNames = [
    names.archive,
    names.sbom,
    names.manifest
  ].sort(compareText)
  if (
    compactJson([...checksums.keys()].sort(compareText)) !==
    compactJson(expectedChecksumNames)
  ) {
    throw new Error('SHA256SUMS must contain the exact release artifact set.')
  }
  const archiveSha256 = verifyChecksum(checksums, names.archive, archive)
  const sbomSha256 = verifyChecksum(checksums, names.sbom, sbom)
  const manifestSha256 = verifyChecksum(checksums, names.manifest, manifest)

  const release = expectJsonObject(
    parseReleaseJson(manifest.toString('utf8'), names.manifest),
    names.manifest
  )
  requireExactKeys(
    release,
    [
      'artifacts',
      'files',
      'lockfile',
      'previousStableTag',
      'schemaVersion',
      'source',
      'tools',
      'version'
    ],
    'release manifest'
  )
  if (release['schemaVersion'] !== 1) {
    throw new Error('Release manifest schemaVersion must be 1.')
  }
  if (release['version'] !== policy.version) {
    throw new Error('Release manifest version does not match.')
  }
  const previousStable = parseReleaseVersion(
    expectString(release['previousStableTag'], 'release previousStableTag')
  )
  if (
    previousStable.rc !== null ||
    compareReleaseVersions(
      previousStable,
      parseReleaseVersion(policy.version)
    ) >= 0
  ) {
    throw new Error('Release manifest previousStableTag is invalid.')
  }
  const source = expectJsonObject(release['source'], 'release source')
  requireExactKeys(source, ['sha', 'sourceDateEpoch', 'tree'], 'release source')
  if (
    source['sha'] !== options.sourceSha ||
    source['tree'] !== options.treeSha
  ) {
    throw new Error('Release manifest source identity does not match.')
  }
  const sourceDateEpoch = expectInteger(
    source['sourceDateEpoch'],
    'release sourceDateEpoch'
  )
  requireSafeEpoch(sourceDateEpoch)
  const tools = expectJsonObject(release['tools'], 'release tools')
  requireExactKeys(tools, ['ncc', 'node', 'npm'], 'release tools')
  const expectedTools: ToolVersions = {
    node: process.version,
    npm: readNpmVersion(),
    ncc: readNccVersion(projectRoot)
  }
  for (const name of ['ncc', 'node', 'npm'] as const) {
    if (
      expectNonEmptyString(tools[name], `release tool ${name}`) !==
      expectedTools[name]
    ) {
      throw new Error(`Release manifest tool ${name} does not match.`)
    }
  }
  const lockfileMetadata = verifyArtifactMetadataShape(
    release['lockfile'],
    'release lockfile',
    'package-lock.json'
  )
  const lockfile = readFileSync(resolve(projectRoot, 'package-lock.json'))
  if (
    lockfileMetadata.sha256 !== sha256(lockfile) ||
    lockfileMetadata.size !== lockfile.length
  ) {
    throw new Error('Release manifest lockfile metadata does not match source.')
  }

  const artifacts = expectJsonObject(release['artifacts'], 'release artifacts')
  requireExactKeys(artifacts, ['archive', 'sbom'], 'release artifacts')
  const archiveMetadata = verifyArtifactMetadataShape(
    artifacts['archive'],
    'release archive metadata',
    names.archive
  )
  const sbomMetadata = verifyArtifactMetadataShape(
    artifacts['sbom'],
    'release SBOM metadata',
    names.sbom
  )
  if (
    archiveMetadata.sha256 !== archiveSha256 ||
    archiveMetadata.size !== archive.length ||
    sbomMetadata.sha256 !== sbomSha256 ||
    sbomMetadata.size !== sbom.length
  ) {
    throw new Error('Release manifest artifact metadata does not match.')
  }

  const archiveEntries = inspectReleaseArchive(
    archive,
    policy.version,
    sourceDateEpoch
  )
  const fileMetadataByPath = expectJsonObject(release['files'], 'release files')
  requireExactKeys(fileMetadataByPath, RELEASE_ACTION_FILES, 'release files')
  for (const [name, archived] of archiveEntries) {
    if (name.endsWith('/')) continue
    const path = name.slice(policy.assetPrefix.length + 1)
    const metadata = verifyFileMetadataShape(
      fileMetadataByPath[path],
      `release file metadata for ${path}`
    )
    if (
      metadata.sha256 !== sha256(archived) ||
      metadata.size !== archived.length
    ) {
      throw new Error(`Release file metadata does not match ${path}.`)
    }
  }

  const spdx = expectJsonObject(
    parseReleaseJson(sbom.toString('utf8'), names.sbom),
    names.sbom
  )
  validateReleaseSpdxDocument(
    spdx,
    policy.version,
    options.sourceSha,
    sourceDateEpoch
  )

  return {
    version: policy.version,
    archiveSha256,
    sbomSha256,
    manifestSha256,
    archivedFiles: RELEASE_ACTION_FILES
  }
}

function policyOutputs(
  policy: ReleasePolicy
): Readonly<Record<string, string>> {
  return {
    version: policy.version,
    prerelease: String(policy.prerelease),
    latest: String(policy.latest),
    update_major: String(policy.updateMajor),
    major_tag: policy.majorTag,
    asset_prefix: policy.assetPrefix
  }
}

function writeWorkflowOutputs(
  outputs: Readonly<Record<string, string>>,
  outputPath: string | undefined
): void {
  if (outputPath === undefined) return
  for (const [key, value] of Object.entries(outputs)) {
    if (value.includes('\n')) {
      const delimiter = '__BRANCH_DEPLOY_RELEASE_OUTPUT__'
      if (value.includes(delimiter)) {
        throw new Error(`Workflow output ${key} contains its delimiter.`)
      }
      appendFileSync(
        outputPath,
        `${key}<<${delimiter}\n${value}\n${delimiter}\n`
      )
    } else {
      appendFileSync(outputPath, `${key}=${value}\n`)
    }
  }
}

type ReleaseCliCommand = 'build' | 'describe' | 'validate' | 'verify'

const CLI_FLAGS: Readonly<Record<ReleaseCliCommand, readonly string[]>> = {
  build: [
    'output',
    'output-dir',
    'previous-stable-tag',
    'project-root',
    'source-date-epoch',
    'source-sha',
    'tree-sha',
    'version'
  ],
  describe: ['output', 'version'],
  validate: ['next', 'output', 'previous'],
  verify: [
    'output',
    'output-dir',
    'project-root',
    'source-sha',
    'tree-sha',
    'version'
  ]
}

function parseCliCommand(value: string | undefined): ReleaseCliCommand {
  if (value === undefined) {
    throw new Error('Expected a command: describe, validate, build, or verify.')
  }
  switch (value) {
    case 'build':
    case 'describe':
    case 'validate':
    case 'verify':
      return value
    default:
      throw new Error(`Unknown command: ${value}`)
  }
}

function parseCliArguments(argv: readonly string[]): {
  readonly command: ReleaseCliCommand
  readonly flags: ReadonlyMap<string, string>
} {
  const command = parseCliCommand(argv[0])
  const allowedFlags = new Set(CLI_FLAGS[command])
  const flags = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      throw new Error('CLI arguments must use --name value pairs.')
    }
    const name = flag.slice(2)
    if (!allowedFlags.has(name)) {
      throw new Error(`Unknown flag for ${command}: --${name}`)
    }
    if (flags.has(name)) throw new Error(`Duplicate CLI flag: --${name}`)
    flags.set(name, value)
  }
  return {command, flags}
}

function requiredFlag(
  flags: ReadonlyMap<string, string>,
  name: string
): string {
  const value = flags.get(name)
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required flag: --${name}`)
  }
  return value
}

function parseEpoch(input: string): number {
  if (!/^[0-9]+$/.test(input)) {
    throw new Error('--source-date-epoch must be an integer.')
  }
  const epoch = Number(input)
  requireSafeEpoch(epoch)
  return epoch
}

export interface ReleaseCliIo {
  readonly cwd: string
  readonly writeStdout: (value: string) => void
}

const PROCESS_CLI_IO: ReleaseCliIo = {
  cwd: process.cwd(),
  writeStdout: value => process.stdout.write(value)
}

function printOutputs(
  outputs: Readonly<Record<string, string>>,
  io: ReleaseCliIo
): void {
  io.writeStdout(`${JSON.stringify(outputs)}\n`)
}

export function runReleaseArtifactsCli(
  argv: readonly string[],
  defaultVersion: string,
  io: ReleaseCliIo = PROCESS_CLI_IO
): void {
  const {command, flags} = parseCliArguments(argv)
  const outputFlag = flags.get('output')
  const outputPath =
    outputFlag === undefined ? undefined : resolve(io.cwd, outputFlag)

  if (command === 'describe') {
    const outputs = policyOutputs(
      createReleasePolicy(requiredFlag(flags, 'version'))
    )
    writeWorkflowOutputs(outputs, outputPath)
    printOutputs(outputs, io)
    return
  }

  if (command === 'validate') {
    const next = flags.get('next') ?? defaultVersion
    const outputs = {
      ...policyOutputs(
        validateVersionTransition(requiredFlag(flags, 'previous'), next)
      ),
      previous_version: requiredFlag(flags, 'previous')
    }
    writeWorkflowOutputs(outputs, outputPath)
    printOutputs(outputs, io)
    return
  }

  if (command === 'build') {
    const projectRoot = resolve(
      io.cwd,
      flags.get('project-root') ?? PROJECT_ROOT
    )
    const outputDirectory = resolve(io.cwd, requiredFlag(flags, 'output-dir'))
    const artifacts = buildReleaseArtifacts({
      projectRoot,
      outputDirectory,
      version: requiredFlag(flags, 'version'),
      sourceSha: requiredFlag(flags, 'source-sha'),
      treeSha: requiredFlag(flags, 'tree-sha'),
      previousStableTag: requiredFlag(flags, 'previous-stable-tag'),
      sourceDateEpoch: parseEpoch(requiredFlag(flags, 'source-date-epoch'))
    })
    const outputs = {
      version: artifacts.version,
      archive: normalizedPath(relative(io.cwd, artifacts.archivePath)),
      sbom: normalizedPath(relative(io.cwd, artifacts.sbomPath)),
      manifest: normalizedPath(relative(io.cwd, artifacts.manifestPath)),
      checksums: normalizedPath(relative(io.cwd, artifacts.checksumsPath)),
      provenance_bundle_name: artifacts.provenanceBundleName,
      sbom_bundle_name: artifacts.sbomBundleName,
      subject_paths: artifacts.subjectPaths
        .map(path => normalizedPath(relative(io.cwd, path)))
        .join('\n')
    }
    writeWorkflowOutputs(outputs, outputPath)
    printOutputs(outputs, io)
    return
  }

  const verified = verifyReleaseArtifacts({
    outputDirectory: resolve(io.cwd, requiredFlag(flags, 'output-dir')),
    projectRoot: resolve(io.cwd, flags.get('project-root') ?? PROJECT_ROOT),
    version: requiredFlag(flags, 'version'),
    sourceSha: requiredFlag(flags, 'source-sha'),
    treeSha: requiredFlag(flags, 'tree-sha')
  })
  const outputs = {
    version: verified.version,
    archive_sha256: verified.archiveSha256,
    sbom_sha256: verified.sbomSha256,
    manifest_sha256: verified.manifestSha256
  }
  writeWorkflowOutputs(outputs, outputPath)
  printOutputs(outputs, io)
}
