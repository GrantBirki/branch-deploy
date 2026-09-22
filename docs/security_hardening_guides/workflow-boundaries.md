# Workflow trust boundaries

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

## Permissions and credential reach

Inventory each job's effective `GITHUB_TOKEN`, extra tokens, cloud credentials, backend credentials, OIDC permission, runner network access, and persistent files. Limit permissions per job; the Action's comment, lock, and deployment operations have different needs from a build or a Terraform plan.

Granting `id-token: write` lets code in that job request an OIDC token. A later credential-fetch step does not by itself prevent earlier code from using that capability. The credential issuer must enforce the intended repository, workflow, ref, environment, audience, and other supported claims. Verify the issuer's actual claim support rather than inventing a policy from claim names.

Separate build and deploy jobs when the build must evaluate arbitrary project code. Give the build only the authority it needs, and give the deploy job trusted orchestration plus a narrowly defined artifact. A fresh job isolates processes; it does not make the artifact authentic or safe to execute. Bind artifacts to the expected repository, commit, workflow, run, and producer identity before using them.

Repository workflow defaults, environment protection, and credential-issuer policy are live settings. Record them separately from YAML. A proposed workflow change is not evidence those settings changed, and permission to edit a workflow does not authorize changing them.

These boundaries follow [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use) and [OIDC model](https://docs.github.com/en/actions/concepts/security/openid-connect). They require verification in the consumer, including its hosting platform and runner type.

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
