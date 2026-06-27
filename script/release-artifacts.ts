import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {runReleaseArtifactsCli} from '../src/release-artifacts.ts'
import {VERSION} from '../src/version.ts'

const entrypoint = process.argv[1]
if (
  entrypoint !== undefined &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  try {
    runReleaseArtifactsCli(process.argv.slice(2), VERSION)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`release-artifacts: ${detail}\n`)
    process.exitCode = 1
  }
}
