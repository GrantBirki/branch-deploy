# Workflow trust boundaries

## TLDR

- Check who can request a run and which code the workflow will execute.
- Load helper scripts from a protected commit, then check PR inputs before giving Terraform credentials.
- Include caches, downloaded files, and other steps in the review. They can affect what runs or expose secrets too.

## What can run with credentials

Review a workflow as a sequence of inputs reaching processes with authority. The trigger matters, but so do checkouts, helper scripts, provider binaries, caches, artifacts, OIDC access, and post-job actions.

## Public example: restricting comment authors

[GrantBirki/software#43](https://github.com/GrantBirki/software/pull/43) added this condition to an existing PR-comment job:

```yaml
contains(fromJSON('["OWNER", "MEMBER"]'), github.event.comment.author_association)
```

Combined with the existing PR check, the job-level fragment is:

```yaml
if: >-
  ${{ github.event.issue.pull_request &&
      contains(fromJSON('["OWNER", "MEMBER"]'), github.event.comment.author_association) }}
```

This reduces who can start the job. On a personal repository, outside collaborators are not admitted merely because they have write access: `COLLABORATOR` is not in that list. In an organization repository, `MEMBER` is broader than membership in a particular deployment team. Choose that policy deliberately.

Keep Branch Deploy's own permission checks. Author association describes a relationship to the repository; it is not a substitute for current repository permission, review, CI, or environment authorization. A maintainer's comment on someone else's PR does not make that PR's contents trusted.

If the outer job also searches the comment body for command strings, treat that as a scheduling filter. Leave command parsing and authorization to the Action. A substring match is not proof that a comment is a valid deployment request.

The public PR changed only the author-association condition. It does not demonstrate that every other part of the surrounding workflow is safe. The source is the [exact patch](https://github.com/GrantBirki/software/commit/839b5c582ffbe07577d803ac28cfa865dc9e5a10), not an inferred audit of the whole repository.

## Inspect configured exceptions

Read the actual `permissions`, `admins`, `allow_forks`, `allow_sha_deployments`, `skip_reviews`, `skip_ci`, `ignored_checks`, and branch-freshness settings. An existing protection is useful only if the selected mode and environment enforce it. Use the [Action metadata](../../action.yml) and [precheck implementation](../../src/functions/precheck-gates.ts) as the authority for the pinned version.

The ordinary same-repository noop path can proceed without approval, including with a changes-requested review, when its CI and other checks allow it. A consumer that requires approval before evaluating sensitive Terraform inputs needs an additional protected admission check. An explicit SHA deployment or configured admin exception must not silently bypass that consumer check.

Verified commit signatures establish an identity and commit integrity under the repository's verification rules; they do not establish that the code is benign or independently reviewed. Required check names should also be tied to their expected producer where the hosting platform supports that restriction.

## Default-branch workflow versus candidate code

For `issue_comment`, GitHub loads the workflow from the default branch. The workflow can still check out and execute PR-controlled code afterward. Document both revisions: the workflow definition that ran and the exact commit selected by Branch Deploy. [GitHub's event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#issue_comment) defines the event behavior.

For a same-repository comment workflow, use the exact trusted workflow revision for helpers and policy. `github.workflow_sha` identifies the workflow revision; `github.sha` has default-branch semantics for this event. Do not fetch a moving `main` halfway through a run. Reusable workflows and other events need their own repository/ref analysis.

Use `steps.branch-deploy.outputs.sha` for the candidate, never a later lookup of the branch name. Validate revisions before passing them to Git or deriving paths, then compare both checked-out `HEAD` values to the expected revisions. A syntactically valid SHA is not evidence of approval or provenance by itself.

An illustrative validation step, after Branch Deploy admits the operation:

```yaml
- name: validate checkout revisions
  if: steps.branch-deploy.outputs.continue == 'true'
  env:
    TRUSTED_SHA: ${{ github.workflow_sha }}
    CANDIDATE_SHA: ${{ steps.branch-deploy.outputs.sha }}
  shell: bash
  run: |
    set -euo pipefail
    for revision in "$TRUSTED_SHA" "$CANDIDATE_SHA"; do
      [[ "$revision" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || exit 1
    done
```

Use separate fixed checkout directories such as `trusted/` and `candidate/`, shallow fetches, and `persist-credentials: false`. For the full pattern, see [trusted checkouts](../trusted-checkouts.md). Configure each checkout Action at a verified full commit SHA; the validation fragment does not install or pin that Action for you.

## Trusted helpers need trusted paths

Run wrappers, admission checks, credential selection, and result formatting from the trusted checkout. Invoke them with absolute workspace paths. Relative traversal such as `../../trusted/script/plan` from inside the candidate can be redirected by candidate-controlled directory structure or symlinks.

The same review applies to local Actions (`uses: ./...`), package scripts, shell startup files, compiler configuration, and helper imports. A trusted entrypoint that imports a module from the candidate has crossed the boundary again.

Before credentials, validate candidate file types and paths. Reject symlinks or resolve and enforce containment throughout every path you intend to read; checking just the last component is insufficient. Write generated files into a newly created runner-owned temporary directory, not a candidate path chosen by the PR.

A second checkout is an organizational boundary, not process isolation. Arbitrary code running under the same runner account may read or change both directories and shared process state. Do not run candidate executables before privileged steps and assume a later trusted checkout repairs the runner. Use a separate isolated job when arbitrary candidate code must execute.

## Recipe: order the checks before Terraform

This is a consumer workflow design, not an extra Branch Deploy mode. Its purpose is to stop an unsupported candidate before Terraform interprets it or receives deployment credentials. Use it when the candidate supplies configuration and protected code supplies execution policy.

The order matters. A correct guard after `terraform validate` is too late if validation has already started a candidate-selected provider. Likewise, a provider checksum check cannot compensate for an earlier script loaded from the candidate. Implement these stages in trusted workflow code:

1. **Admit the operation.** Check effective maintenance switches and use Branch Deploy's authorization, review, CI, and freshness gates for the requested mode. Stop unless its result permits work. A scheduling filter on the comment body is not this decision.
2. **Freeze and verify identity.** Record the trusted workflow revision and candidate SHA, validate their format, check out those exact commits, and verify both actual `HEAD` values. Keep these values attached to later evidence.
3. **Inspect the candidate without evaluating it.** Check file types and containment, the complete Terraform input set, allowed expression forms, backend/workspace selection, and protected control files. Reject malformed input; route supported sensitive changes through the [current-commit approval policy](terraform-plans.md#approval-must-cover-the-executed-commit).
4. **Verify executable dependencies.** Check the selected toolchain and provider packages against protected policy. If reviewed provider upgrades are supported, verify their independent release evidence before loading them. The candidate cannot replace the verifier or choose its trust policy.
5. **Prepare a controlled runtime.** Create private runner-owned temporary storage, a fresh Terraform data directory, and a deliberate child-process environment. Select CLI configuration, installation paths, root, and backend identity from admitted inputs. Do not restore a candidate-owned `.terraform` directory.
6. **Optionally check native dependency selection without backend credentials.** After admission, a backend-disabled readonly initialization can check Terraform's complete provider requirements. This is useful defense in depth for declarations in another file. Test it with the consumer's pinned Terraform and root layout; some initialization steps require an initialized backend. It is not mandatory for every workflow or a substitute for package provenance.
7. **Acquire only the credentials needed for the next operation.** Initialize the admitted backend using the controlled environment and unchanged provider-installation policy. Then create the plan. Do not silently migrate state or update the lockfile to recover from a mismatch.
8. **Inspect and optionally apply.** `.noop` ends without apply. For deployment, inspect the saved plan, enforce the mutation policy, select any supported narrower write credentials, and apply that same plan. Use [failure-preserving reporting](rollout-and-recovery.md#recipe-keep-reporting-from-hiding-failure).
9. **Clean up and complete.** Remove sensitive files, preserve the real operation result, and let the configured completion mechanism update comments, deployment status, and owned locks. Record skipped work as skipped.

For stage 6, this command is an optional fragment after the earlier checks, with `TF_ROOT` and the environment supplied by trusted tooling:

```bash
terraform -chdir="$TF_ROOT" init -backend=false -input=false -no-color -lockfile=readonly
```

Supply the same approved local installation policy as the later initialization if the consumer vendors providers. `-backend=false` does not disable module retrieval or make arbitrary configuration safe. Reject unsupported modules before this step. Terraform documents these independent operations in its [initialization reference](https://developer.hashicorp.com/terraform/cli/commands/init).

“Before credentials” here means before acquiring the additional backend/provider credentials. A job token and OIDC request capability may already be available. Only trusted code should execute during the earlier stages; delaying a secret-fetch step is not isolation from candidate code.

### Prove the ordering with harmless fixtures

Use a temporary local root, fake issuer, mock provider, and loopback HTTP listener. Record calls at each boundary instead of relying only on the guard's error text. Keep this test independent of live cloud services and resource inventory.

| Fixture | Expected observation |
| --- | --- |
| Supported literal edit | Admission succeeds; the intended mock plan runs with dummy credentials. |
| Unsupported built-in remote-state read | Admission fails; issuer, provider, and listener counters remain zero. |
| Provider requirement added in a second configuration file | The guard rejects it, or the separately tested native readonly dependency check fails; no provider executable runs and the lockfile is unchanged. |
| Candidate replaces the trusted checker or redirects a checked path | Admission fails before any candidate executable or additional credential request. |
| Required approval covers a different commit | Verification fails; the selected candidate never reaches Terraform. |

Test each layer separately as well. A native initialization fixture can install a harmless executable stub that only writes a marker under the fixture directory; assert the marker is absent when dependency selection fails. A workflow-wiring test should prove the protected guard actually precedes initialization and credential retrieval. A parser unit test alone cannot establish that ordering. These are proposed test contracts; a consumer must run them against its own wrapper and pinned tools before claiming coverage.

## Permissions and credential reach

Inventory each job's effective `GITHUB_TOKEN`, extra tokens, cloud credentials, backend credentials, OIDC permission, runner network access, and persistent files. Limit permissions per job; the Action's comment, lock, and deployment operations have different needs from a build or a Terraform plan.

Granting `id-token: write` lets code in that job request an OIDC token. A later credential-fetch step does not by itself prevent earlier code from using that capability. The credential issuer must enforce the intended repository, workflow, ref, environment, audience, and other supported claims. Verify the issuer's actual claim support rather than inventing a policy from claim names.

Separate build and deploy jobs when the build must evaluate arbitrary project code. Give the build only the authority it needs, and give the deploy job trusted orchestration plus a narrowly defined artifact. A fresh job isolates processes; it does not make the artifact authentic or safe to execute. Bind artifacts to the expected repository, commit, workflow, run, and producer identity before using them.

Repository workflow defaults, environment protection, and credential-issuer policy are live settings. Record them separately from YAML. A proposed workflow change is not evidence those settings changed, and permission to edit a workflow does not authorize changing them.

These boundaries follow [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use) and [OIDC model](https://docs.github.com/en/actions/concepts/security/openid-connect). They require verification in the consumer, including its hosting platform and runner type.

## Recipe: give credentials only to their intended process

This recipe reduces accidental credential exposure whether plan and apply use the same identity or separate ones. It does not change the consumer's credential model, and it does not isolate mutually hostile processes under one runner account.

Use this data flow:

```text
trusted issuer client
  -> private response file or pipe
  -> protected parser and exact field validation
  -> required runtime values in the Terraform child only
  -> redacted result data for the reporter
  -> cleanup
```

The consumer must define the issuer's documented format, the runtime field names, the permitted output location, and which process needs each value. For a synthetic JSON issuer response, this might be:

```json
{"runtime_token":"test-only-runtime-value","backend_token":"test-only-backend-value"}
```

Those keys are illustrative; they are not Terraform's environment-variable names. Map them through protected code to the specific provider/backend's documented inputs. A credential used to mint a runtime token does not belong in the Terraform environment.

1. Create a fresh private directory under the runner's temporary storage with owner-only access before issuance. Do not accept a destination from candidate configuration. Keep credential files out of either checkout and outside upload/cache paths.
2. Prefer a structured issuer response or a documented data file. Parse it without shell evaluation. Reject duplicate keys, unexpected fields, missing/empty required values, malformed multiline values, and unsupported response versions. Choose a parser capable of detecting duplicates if the format permits them; ordinary JSON parsing can silently keep the last duplicate.
3. When files are required, create them exclusively with restrictive permissions from the first write. Validate the parent directory and containment, refuse symlinks and unexpected existing paths, and verify file type and permissions before reading. A check followed by a later open is not race-proof against a hostile same-user process; use supported no-follow/descriptor operations where needed and preserve runner isolation.
4. Mask secret values using the platform's correctly escaped masking interface without printing a diagnostic copy. Preserve significant newlines in key material. Avoid command-line arguments, job outputs, and job-wide environment exports for secret values.
5. Spawn Terraform with explicit arguments and no shell interpolation. Build a deliberate environment containing required operating-system settings, reviewed certificate/proxy settings, approved Terraform controls, and only the runtime secrets it needs. Do not blindly inherit variable files, `TF_VAR_*`, `TF_CLI_ARGS*`, debug logging, development overrides, or language-loader injection variables from an uncontrolled parent. See [Terraform's environment inputs](https://developer.hashicorp.com/terraform/cli/config/environment-variables).
6. Keep issuance credentials away from Terraform and credential values away from formatters/status helpers. Treat plan files and raw provider output as sensitive too: omitting credentials from a formatter's environment does not sanitize the content it reads.
7. Close files and remove them on success and error. Add workflow cleanup for paths created before a later step failed. Cleanup must tolerate issuance never occurring and must only remove validated runner-owned paths. Avoid verbose shell tracing while secrets are in scope.

Use language-appropriate primitives rather than inventing another secret-file protocol. If an issuer only supplies shell output, account for that file as executable trusted code; a structured response with a protected parser avoids giving returned text shell authority. Do not claim both approaches have the same boundary.

### Verify exposure and cleanup

With fake values, record the environment of a dummy Terraform child and a dummy reporter. Assert the child receives its required runtime values, the reporter receives none, and issuer-only credentials reach neither. Seed unexpected inherited variables to prove the wrapper's environment policy takes effect. Preserve required proxy/certificate inputs deliberately so hardening does not silently break legitimate access.

Also test duplicate fields, malformed multiline content, an unexpected extra key, a symlink, a path outside temporary storage, permissive file modes, and a preexisting output path. Each should fail without echoing values. Test cleanup after issuer failure, parse failure, child failure, and successful completion; verify unrelated files remain intact.

Restrictive files protect against accidental sharing and some other-user access. Masking protects selected log representations. Neither guarantees secrecy from a compromised same-user process, and clearing a string does not guarantee memory erasure. Force-cancellation or runner loss can bypass cleanup, so short credential lifetime, isolated runners, and bounded artifact retention remain relevant.

## Cache reads are an input too

Inspect explicit cache steps, automatic setup-action caching, reusable workflows, and post-job saves. A lockfile hash in a cache key does not authenticate the cached executable.

For privileged jobs that need no Actions cache, use `cache-mode: none` where supported. `read` still permits restoring content; it only prevents saving. Review job overrides. Check setup-action inputs at the pinned revision, including automatic package-manager caching. A denied cache operation can log a skip while the job stays green. [GitHub documents the modes and enforcement](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#cache-mode).

Actions cache restrictions do not clean a self-hosted runner, clear a local tool cache, or validate downloaded artifacts. Treat each of those as a separate input path. Do not restore a cached `.terraform` directory into a credentialed job just because the dependency lockfile is unchanged.

## Network controls and runner isolation

Start a network monitor before the work it is meant to observe. Audit mode records attempted destinations; it does not block them. An enforcement claim needs evidence that a disallowed synthetic request actually failed, alongside evidence that required requests still work.

Derive allowed destinations per job. A test job, provider installation, backend initialization, and infrastructure refresh may have different requirements. Do not turn every observed hostname into an allowlist entry without understanding who selected it.

Review IPv4, IPv6, DNS, proxy behavior, containers, host networking, privileged processes, metadata services, and private network routes according to the tool's real coverage. Docker alone is not a security boundary when the process has the host socket, elevated capabilities, or shared secrets. Neither an audit log nor a network allowlist makes an approved API endpoint safe for all data and operations.

## Expressions, output, and cleanup

Pass untrusted text through quoted environment variables or structured Action inputs, not directly into shell source. This includes branch names, parameters, comment bodies, and deployment output. Do not use `eval`, source a generated credential file as shell code, or let candidate configuration select a trusted executable path.

Plan output is untrusted text and can contain sensitive values. Use a protected formatter, bound the output size, redact deliberately, and preserve an honest failure or truncation indicator. Do not include raw state or saved plans in public comments.

For multiline Actions file commands, use a random delimiter and check that no output line equals it. A fixed `EOF` delimiter lets input containing that line escape its intended value. Prefer the existing [deployment message guidance](../custom-deployment-messages.md) to another templating layer. The current renderer inserts results once; that protects against template evaluation, not disclosure of secrets placed in the results.

Use unconditional cleanup for credential and plan files, but account for runner loss and force-cancellation. Temporary storage with restrictive permissions limits accidental exposure; it does not protect secrets from another malicious process running as the same user.

## Review prompts

- Can a denied commenter start any credential-bearing job before Action authorization?
- Can a same-repository PR change an executable, config search path, provider, cache entry, or local Action that this job consumes?
- Does a trusted helper load anything from the candidate before admission?
- Can candidate code request OIDC credentials or call GitHub using the job token before the visible secret-fetch step?
- Can a low-trust build replace an artifact that a higher-trust job executes?
- Does the observed result distinguish audit from enforcement, and a skipped step from a successful one?
