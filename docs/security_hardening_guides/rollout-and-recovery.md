# Rollout, results, and recovery

## TLDR

- During deployment, create a fresh plan from the approved commit and apply that exact saved plan.
- Keep Terraform failures visible even when reporting succeeds. A green workflow alone does not prove the deployment worked.
- Check the actual result before merging or retrying. Recovery steps must preserve the same review and credential protections.

## What counts as success

A workflow-hardening change should preserve infrastructure behavior unless a separate, reviewed change intentionally alters it. Keep the proof tied to the selected commit, workflow revision, deployment environment, backend, and workspace.

## Plan, approve, apply the saved plan

Use the consumer's normal reviewed deployment path. A typical sequence is static CI, `.noop`, review, `.deploy`, inspection of the real apply result, and merge. If a fresh post-deploy plan is part of the operating model, require that evidence too. Do not replace an unavailable integration check with a green unit-test badge.

At `.deploy`, create a fresh plan from the approved immutable configuration and apply that exact saved plan. A much earlier `.noop` is evidence for review, not a guarantee that live state remains unchanged. Inspect unexpected drift before applying; do not regenerate an unrelated plan inside the apply command.

Store the binary plan, JSON view, and text view in a restrictive runner-owned temporary directory. Bind them to the same configuration, variables, backend, workspace, and tool/provider versions. If jobs exchange plans, protect both artifact provenance and confidentiality; never accept a plan uploaded by an untrusted PR job as an authorized apply input.

Saved plans and their JSON views can contain sensitive values even when normal terminal output hides them. Treat them as sensitive artifacts with bounded retention. See [Terraform's saved-plan guidance](https://developer.hashicorp.com/terraform/cli/commands/plan#out-filename).

## Recipe: keep reporting from hiding failure

A workflow may need Terraform's error output to explain a failed preview or deployment. Temporarily allowing a failed step to continue is reasonable only when a later step restores the failure before Branch Deploy completes the operation.

GitHub distinguishes a step's original `outcome` from its `conclusion` after `continue-on-error` is applied. The latter can be `success` for a failed command. Check the original outcome when deciding whether apply may run and whether the operation succeeded. See [the steps context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#steps-context).

This **single-job fragment** assumes an earlier Branch Deploy step with ID `branch-deploy`. `TRUSTED_HELPERS` must be a verified absolute path set by protected workflow code. The named helper scripts are illustrative contracts to implement in the consumer: `plan` creates one saved plan and returns the real Terraform exit status; `apply-saved-plan` uses that artifact; `report` renders bounded diagnostics without declaring success from log text; `cleanup` removes only validated temporary files. If planning uses detailed exit codes, its helper must deliberately distinguish ordinary proposed changes from errors and enforce the intended plan policy.

```yaml
- name: plan
  id: plan
  if: steps.branch-deploy.outputs.continue == 'true'
  continue-on-error: true
  run: '"${TRUSTED_HELPERS}/plan"'

- name: apply saved plan
  id: apply
  if: steps.branch-deploy.outputs.continue == 'true' && steps.branch-deploy.outputs.noop == 'false' && steps.plan.outcome == 'success'
  continue-on-error: true
  run: '"${TRUSTED_HELPERS}/apply-saved-plan"'

- name: render operation result
  if: always() && steps.branch-deploy.outputs.continue == 'true'
  env:
    NOOP: ${{ steps.branch-deploy.outputs.noop }}
    PLAN_OUTCOME: ${{ steps.plan.outcome }}
    APPLY_OUTCOME: ${{ steps.apply.outcome }}
  run: '"${TRUSTED_HELPERS}/report"'

- name: preserve operation failure
  if: always() && steps.branch-deploy.outputs.continue == 'true'
  env:
    NOOP: ${{ steps.branch-deploy.outputs.noop }}
    PLAN_OUTCOME: ${{ steps.plan.outcome }}
    APPLY_OUTCOME: ${{ steps.apply.outcome }}
  shell: bash
  run: |
    set -euo pipefail
    [[ "$PLAN_OUTCOME" == "success" ]] || exit 1
    case "$NOOP" in
      true) [[ "$APPLY_OUTCOME" == "skipped" ]] ;;
      false) [[ "$APPLY_OUTCOME" == "success" ]] ;;
      *) exit 1 ;;
    esac

- name: cleanup
  if: always() && steps.branch-deploy.outputs.continue == 'true'
  run: '"${TRUSTED_HELPERS}/cleanup"'
```

The fragment deliberately fails a deploy whose apply was unexpectedly skipped. It also rejects a noop that actually applied. It cannot undo an apply; the earlier apply condition and normal authorization are the prevention controls. Check the pinned Action's boolean output contract before adapting the conditions.

Reporting gets the actual step outcomes as well as redacted output. A provider can print success-looking text before failing, so a line containing “Apply complete” is not the authority for status. Keep rendering failure visible too: successful Terraform followed by failed reporting is a reporting failure with potentially completed infrastructure work. Investigate before any retry.

Cleanup and reporting may run after an operation fails, but neither should reset the saved failure to success. For pipelines, preserve Terraform's exit status; a successful `tee` or formatter is insufficient. For multiple jobs, use [the completion recipe](#multi-job-completion-must-describe-the-work) and the pinned Action's result mode instead of assuming this single-job fragment carries state across jobs.

### Failure matrix

| Plan | Apply | Expected operation evidence |
| --- | --- | --- |
| Success | Skipped for noop | Preview succeeds; no apply or deployment completion is invented. |
| Failure | Skipped | Job fails even if diagnostics render successfully. |
| Success | Failure | Job fails; report identifies apply failure and possible partial mutation. |
| Success | Skipped for deploy | Job fails because required work did not run. |
| Success | Success | Deployment can succeed only if the other required steps also succeed. |
| Cancelled or missing | Any | No success; retain cancellation/unknown status and inspect before recovery. |

Test those paths with fake helpers. Also test renderer failure after a successful apply, cleanup failure, a nonzero command that prints success-shaped text, and a rejected operation that should never reach any helper. Inspect both the workflow result and Branch Deploy's comment/deployment result. Force-cancellation may prevent any final step from running; preserve that limitation in the recovery instructions.

## Require zero changes for hardening-only rollouts

For a change that should leave infrastructure alone, inspect the plan and apply output, not just the job conclusion. A successful apply that changed resources is not a successful zero-change validation. Imports, output/state changes, replacements, and forgotten resources also need review; resource action counts alone can omit relevant state effects.

If the wrapper uses `-detailed-exitcode`, handle `0` as no changes, `1` as an error, and `2` as proposed changes. Capture the exit code without letting `set -e` end the script first. With a pipeline, preserve Terraform's status rather than the status of `tee`. The [plan command reference](https://developer.hashicorp.com/terraform/cli/commands/plan#detailed-exitcode) defines these codes.

This fragment intentionally permits only a no-change rollout; it is not the general path for applying reviewed resource changes. `TF_ROOT` and `PLAN_FILE` must be selected by trusted workflow code after normal authorization and initialization:

```bash
set -euo pipefail
status=0
terraform -chdir="$TF_ROOT" plan -input=false -detailed-exitcode -out="$PLAN_FILE" || status=$?
case "$status" in
  0) ;;
  2) printf '%s\n' 'Unexpected changes; stopping before apply.' >&2; exit 2 ;;
  *) printf 'Plan failed with status %s.\n' "$status" >&2; exit "$status" ;;
esac
terraform -chdir="$TF_ROOT" apply -input=false "$PLAN_FILE"
```

If a hardening change reveals drift, separate the drift from the hardening. Verify the intended state before changing HCL. Do not suppress the difference with broad `ignore_changes`, change state by hand, or add a broader token just to make a plan green.

## Introducing new protected tooling

An `issue_comment` PR run uses the existing default-branch workflow and helpers. It cannot prove the PR's new trusted checker or workflow ran. Passing pre-merge CI and a zero-change `.noop` remain useful, but describe exactly what they tested.

When existing protected code permits the PR's ordinary deployment, follow the normal deploy-before-merge process. After merge, use an authorized, harmless follow-up PR to exercise the changed comment path if live proof is needed. Offline regression tests should already cover malicious inputs without production credentials.

Sometimes the old protected policy deliberately rejects a change to the policy itself. Do not solve this by executing the PR's replacement checker with credentials. Plan a narrow bootstrap with the repository owner:

1. Identify the exact rejection, intended commit, required CI, and independent approval.
2. Identify every apply entrypoint and the effective settings that control it, including environment overrides and already queued or running work.
3. Obtain authorization for any exceptional merge or setting change. Save the original settings and stop or drain operations according to the established maintenance procedure.
4. Use the existing apply-disabled path only if its implementation is verified on every entrypoint. Some workflows become completely inert when applies are disabled; others still plan. Do not invent a plan capability by toggling a variable.
5. Land the reviewed protected-code change and inspect the actual post-merge behavior. Keep applies disabled if the plan is unexpected or the recovery is incomplete.
6. Exercise the newly trusted path, restore only the recorded settings after the intended plan is accepted, and finish any separately authorized reconciliation.

This is an exceptional recovery procedure, not the expected process for every provider bump. A protected verifier that safely admits a reviewed provider upgrade can remove that recurring friction; see [provider installation choices](terraform-plans.md#providers-are-executable-dependencies).

## Optional recipe: diagnose a runner without deploying

Use a dedicated maintenance diagnostic when runner, network, or credential-access changes need live verification and a normal deployment would obscure the question being tested. This pattern runs an authorized plan against protected configuration. It never applies and must not create evidence that satisfies a deployment-required merge gate.

Successful authentication proves only that the issuer accepted the request. It does not prove the runner can reach the state backend or read the actual resource API. A useful diagnostic exercises those boundaries separately and identifies which one failed.

### Design the diagnostic path

1. Restrict dispatch to the protected default branch and record the exact event SHA. Check out that SHA, verify `HEAD`, and use only its tooling and configuration. A manual dispatch can select a branch, so merely declaring `workflow_dispatch` is insufficient; see [GitHub's manual-run behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
2. Enforce the same protected-ref restriction in the credential issuer or environment policy where supported. A workflow condition cannot defend itself against an untrusted branch rewriting that condition. Verify the live protections separately from the proposed YAML.
3. Use the same state-operation concurrency key as normal planning and deployment. Require the established maintenance settings before acquiring additional credentials. Confirm active/queued operations are drained as needed; a switch does not revoke an already running apply.
4. Give the diagnostic no deployment-write permission, no deployment-completion Action, and no apply helper. When using a GitHub environment, use the hosting platform's supported setting to suppress automatic deployment creation, or choose another design that preserves its protection without publishing a deployment record. Verify the absence of a new record after the test.
5. If the consumer relies on a fixed egress policy, check the observed source address against a protected expected range using a bounded, approved discovery method. Fail on discovery errors as well as mismatches. A public address check does not prove every later connection uses the same route, so also test the intended service path.
6. Initialize the intended backend with the normal trusted provider and lockfile policy. Perform an authorized refresh/plan using the consumer's existing credentials. Require no changes; report drift without applying, importing, migrating, or editing state to quiet it.
7. Preserve bounded diagnostics, remove temporary credentials/plans, and report which access checks succeeded. Keep this result separate from the normal PR review and deployment gates.

For a consumer that defines the two illustrative environment inputs below, this fragment checks maintenance mode before credential issuance:

```bash
set -euo pipefail
[[ "$PLAN_ENABLED" == "true" && "$APPLY_ENABLED" == "false" ]] || exit 1
```

These names are consumer-defined inputs, not Branch Deploy settings. Missing or malformed values must stop the job. After the preceding identity, provider, and credential checks, the diagnostic can use:

```bash
set -euo pipefail
terraform -chdir="$TF_ROOT" plan -input=false -no-color -lock-timeout=60s -detailed-exitcode
```

For this diagnostic, exit code `2` deliberately fails because any proposed change needs separate review. Use a bounded backend-lock wait appropriate to the consumer. A backend may acquire a lock during planning; “never applies” does not mean the process has no credentials, performs no API calls, or can never affect an external service through provider behavior. Review that behavior first.

### Diagnostic regression cases

Reject non-default-branch dispatch, a checkout mismatch, absent/wrong switches, unexpected network origin, origin-discovery failure, backend initialization failure, provider read failure, and drift. A successful authentication response followed by denied resource access must fail. A clean plan should succeed without calling an apply stub or producing a deployment record.

Test the workflow's structure as well as its helpers: no apply command, no deployment-write permission, expected concurrency, pinned protected checkout, and protected tooling. Use fake endpoints for failure tests. Running the real maintenance diagnostic, changing switches, or changing issuer policy requires separate operational authorization. A diagnostic-only success is not permission to merge or deploy a PR.

## Switches are not revocation

For consumers with emergency plan/apply switches, enable operations only for an explicit recognized value such as the literal string `true`. Missing, empty, or malformed values should disable the operation. Apply the same policy to comment workflows, default-branch reconciliation, scheduled jobs, and manual dispatches.

Changing a variable does not revoke credentials already issued or reliably stop a job that has evaluated the old value. Inspect active and queued runs before treating maintenance as effective. Environment overrides can supersede a repository setting, so verify effective values in the actual execution environment.

A settings change, job cancellation, credential revocation, and merge are separate actions. Do not assume authorization for all of them because a workflow patch is approved.

## Three different kinds of locking

| Mechanism | What it coordinates | What remains your responsibility |
| --- | --- | --- |
| Branch Deploy lock | Deployment ownership for a named environment. | Correct lock owner, sticky policy, command handling, and cleanup. |
| Actions concurrency | Scheduling across jobs/workflows in one repository. | A common key for all operations on the same state and coverage of every entrypoint. |
| Terraform backend lock | Concurrent operations supported by that backend. | Correct backend/workspace and safe recovery after interrupted work. |

Use one repository-wide concurrency key for jobs that touch the same state, including `.noop`, `.deploy`, and default-branch reconciliation. A PR-specific key allows two PRs to operate on the same state concurrently. Separate repositories need backend or external coordination as well.

Avoid cancelling an in-progress apply merely because another comment arrives. With `cancel-in-progress: false`, check the hosting platform's pending-run queue behavior; it does not automatically promise an unlimited queue. Where supported, `queue: max` can retain multiple pending jobs. Keep `.help` and lock-support commands responsive outside the state-operation queue. [GitHub documents concurrency and queue controls](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).

## Multi-job completion must describe the work

Splitting authorization, build, and deployment can reduce authority in a build job. It also moves the point where the final result becomes known. Without a deliberate completion strategy, a trigger job's post action may finish before the downstream work.

For releases supporting [result mode](../result-mode.md), use `skip_completing: true` on the trusted start step and forward its unchanged context to a trusted final job. Pin both Action invocations to the same verified commit. Include every required worker in result selection and do not execute candidate code in the result job.

Each worker must enforce the start context's run-attempt match before doing work. Checking only during final reporting is too late to prevent a partial rerun from executing with old admission evidence. Rerun the whole workflow to obtain fresh checks.

Use `always()` plus an admitted-operation condition for the final job. Distinguish success, failure, cancellation, and intentionally skipped work. For noops, select the jobs actually required for the preview; do not relabel a skipped deploy job as successful work. Noops have no deployment record to complete, but their comments and locks still need truthful completion.

If the pinned release requires manual completion, retain that responsibility explicitly. Report against the deployment ID and immutable context created by the trusted start job. Do not derive an ID from PR files, infer success from an empty output, or delete a lock solely by guessing its branch name.

`always()` cannot guarantee completion after force-cancellation or runner loss. Before recovery, inspect the infrastructure operation, deployment record, and current lock. A reporting failure can follow a successful apply; it is not permission to repeat the apply.

## Lock ownership and merge-time skips

Release only the lock the operation owns. Check environment, PR/run identity, stickiness, and whether the lock has been replaced since acquisition. Current [result-mode cleanup](../result-mode.md) preserves cancellation, sticky, global, and replacement locks according to its documented policy. Configure [unlock-on-merge](../unlock-on-merge.md) with the same environment targets as the deployment workflow.

In [merge-deploy mode](../merge-commit-strategy.md), current Branch Deploy compares the newest identifiable Branch Deploy deployment with the default-branch tree and skips only when the relevant deployment is active and the trees match. A matching tree can have a different commit SHA after a merge commit. An older success or a deployment from another system is not equivalent proof under this policy.

Inspect the job list and the comparison result. A green workflow with its apply job skipped can be the correct duplicate-deployment outcome. It does not establish a new live drift check, and it does not mean newly merged workflow code was exercised through `issue_comment`.

## Regression and rollout evidence

Use small synthetic fixtures and behavior assertions. The goal is to show where execution stops and which legitimate work still proceeds, without mirroring today's resource inventory.

| Case | Evidence to collect |
| --- | --- |
| Routine literal value/list edit without approval | Admission succeeds and a synthetic plan can run. |
| New resource of an already-reviewed type or literal import | The intended subset remains usable without adding inventory exceptions; real state adoption still requires deploy approval. |
| Provider replacement, changed lockfile, or altered verification policy | Rejected before provider loading unless the specific reviewed upgrade policy admits it; policy cannot approve itself. |
| Override, JSON configuration, unquoted block, built-in remote-state read | Rejected before the credential stub or unexpected network call. |
| Removed lifecycle protection | Detected even though no new lifecycle block exists to inspect. |
| Old approval, changed head, or stale rerun context | The wrong revision cannot run through the approved path. |
| Symlink or path traversal | Candidate files cannot redirect trusted executable or result paths. |
| Malicious output delimiter or template-looking text | Output remains data; it cannot write a second environment variable or execute a template. |
| Apply failure, cancellation, reporting failure, or replaced lock | Final status stays truthful and cleanup cannot remove another operation's lock. |
| Disabled switch or environment override | Effective policy stops at the intended point before credentials or mutation. |
| Identical versus different deployment trees | Only the documented active identical-tree case skips reconciliation. |

For native Terraform regression tests, pin the toolchain, use a disposable home/data directory and local backend, clear inherited credentials, and bind mock services to loopback. Assert an explicit absence of unexpected requests. Do not run malicious fixtures with a real job token or production backend just to obtain convincing logs.

Keep test fixtures independent of provider version bumps unless the behavior itself changed. Use existing Linux CI when it proves the required property; Docker or another runner platform needs a specific isolation or compatibility reason.

For an authorized live rollout, record the exact workflow and candidate SHAs, successful CI and review, plan/apply result, skipped steps, deployment status, and lock outcome. Keep public evidence redacted and bounded. State any unexercised path rather than treating a merged patch as proof of every protection.
