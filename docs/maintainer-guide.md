# Maintainer Guide 🧑‍🔬

This document describes the maintenance and release process for `branch-deploy`.

## Project checks

Install the exact dependencies recorded in `package-lock.json` and run the complete non-mutating project check before bundling:

```bash
npm ci
npm run check
```

Regenerate the committed GitHub Action bundle with:

```bash
npm run bundle
```

The supported distribution is `action.yml` plus the committed ES module bundle in `dist/`. This project is not published as an npm library.

## Automated releases 🏷️

Production releases are created automatically after a pull request that changes [`src/version.ts`](../src/version.ts) is merged into `main`. Maintainers must not create or push release tags manually.

The release workflow builds from the immutable merge commit, checks that the committed bundle reproduces exactly, creates deterministic release assets, generates an SPDX SBOM, and signs the build subjects with GitHub artifact attestations. It verifies those artifacts before creating a draft GitHub Release, redownloads the draft assets to verify their digests, and publishes only after every prepublication check succeeds. Repository release immutability must remain enabled for this security boundary.

The release build uses a locked dependency graph and disabled install scripts, but dependency installation still uses the network. The workflow is SLSA Build Level 3-aligned through its reusable build boundary and GitHub artifact attestations; it is not described as a fully hermetic or independently certified build.

### Choosing a version

Versions use one of these formats:

- Stable: `vMAJOR.MINOR.PATCH`, such as `v11.2.0`.
- Release candidate: `vMAJOR.MINOR.PATCH-rc.NUMBER`, such as `v11.2.0-rc.1`.

Every version must increase numerically from the current project version. Successive release candidates increase their RC number, and the corresponding stable version follows its release candidates. Duplicate versions, downgrades, malformed versions, and transitions from a stable version back to an RC of that same version are rejected in pull-request CI.

The automation baseline is `v11.1.5`; versions through that baseline are intentionally not backfilled as GitHub Releases. The first automated release is expected to be `v11.1.6-rc.1`, with generated notes beginning at the existing stable tag `v11.1.2`.

### Preparing a version pull request

1. Update the exported version in [`src/version.ts`](../src/version.ts).
2. Run `npm ci` and `npm run all` so the version and mechanically regenerated `dist/` files are committed together.
3. Open a pull request containing the version bump and regenerated bundle.
4. Review the version transition and all generated changes before merging.

The existing `package-check` workflow validates the version transition and invokes the same reusable release build without attestation permissions when release-sensitive files change. These read-only dry builds receive no OIDC or publication credentials and cannot create attestations, tags, or releases.

Merging the version pull request is the sole normal release trigger. A guarded manual workflow dispatch exists only to retry the version already present at the current `main` commit. It cannot publish an arbitrary historical commit or a different requested version. If `main` has advanced since a failed release event, re-run that original workflow event instead of dispatching a new event with a different source identity.

### Stable and RC behavior

Each exact version receives an immutable exact tag and GitHub Release:

- An RC is published as a prerelease, is never marked latest, and does not move the major compatibility tag.
- A stable version is published as the latest release. After the exact release and all of its assets verify, automation moves the ordinary `vMAJOR` compatibility tag to the same commit.
- No GitHub Release is attached to the movable `vMAJOR` tag, and this project does not maintain a `vMAJOR.MINOR` alias.

Release notes include merged pull requests since the preceding stable exact tag. A stable release following one or more RCs therefore contains the complete set of changes since the preceding stable release.

GitHub release immutability prevents a published exact tag or its assets from being replaced or deleted. Do not attempt to promote an existing RC into a stable release; use a new stable exact version instead.

### Release artifacts and verification

Each release contains the deterministic action archive, SPDX SBOM, release metadata, checksum manifest, build-provenance bundle, and SBOM-attestation bundle. GitHub also creates a release attestation when the immutable release is published.

Verify a published release and its downloaded assets with the GitHub CLI:

```bash
gh release verify vMAJOR.MINOR.PATCH --repo GrantBirki/branch-deploy
gh release verify-asset vMAJOR.MINOR.PATCH path/to/downloaded-asset --repo GrantBirki/branch-deploy
gh attestation verify path/to/downloaded-asset --repo GrantBirki/branch-deploy --signer-workflow GrantBirki/branch-deploy/.github/workflows/release-build.yml
gh attestation verify path/to/action-archive.tar.gz --repo GrantBirki/branch-deploy --signer-workflow GrantBirki/branch-deploy/.github/workflows/release-build.yml --predicate-type https://spdx.dev/Document/v2.3
```

Use the exact RC version in place of `vMAJOR.MINOR.PATCH` when verifying a prerelease. Verification should bind build attestations to the repository's reusable release-build workflow rather than accepting an arbitrary signer.

### Failure recovery

The release workflow is designed for safe retries:

- A matching draft from the same source event is rebuilt and resumed. Valid assets are retained, missing assets are added, and mismatched or unexpected assets stop the run.
- A draft created by an older workflow event is never adopted by a newer event. Re-run the original workflow so its source identity can rebuild and verify the draft, or fix the workflow and publish the next RC. This prevents newer workflow identity from being attached to older source bytes.
- A matching published immutable release is never modified. A retry of its original event verifies it again and, for a stable release, completes or verifies the major-tag update.
- A tag or release targeting a different commit, a non-immutable published release, or a digest mismatch fails closed and requires investigation.
- If an RC has already been published and a later verification step exposes a workflow defect, fix the workflow and publish a new incremented RC. Never delete, replace, or retarget the published RC.

The repository-wide release concurrency group retains queued runs and serializes releases. The publisher also checks the live published-version order before writing a draft and before moving a major tag, so an out-of-order run fails closed instead of publishing or moving an alias backward. Do not work around a failed run by manually pushing a tag or using the GitHub UI to publish a replacement asset.

## Major-version compatibility tags

The stable release workflow is the only supported writer for the movable major tag. For example, after `v12.3.4` is published and verified, automation moves `v12` to the same source commit and verifies the action metadata and bundle at that alias.

Consumers that select `GrantBirki/branch-deploy@v12` receive compatible stable updates within major version 12. Consumers that require immutable selection should pin an exact commit SHA.
