# Rollout, results, and recovery

A workflow-hardening change should preserve infrastructure behavior unless a separate, reviewed change intentionally alters it. Keep the proof tied to the selected commit, workflow revision, deployment environment, backend, and workspace.

## Plan, approve, apply the saved plan

Use the consumer's normal reviewed deployment path. A typical sequence is static CI, `.noop`, review, `.deploy`, inspection of the real apply result, and merge. If a fresh post-deploy plan is part of the operating model, require that evidence too. Do not replace an unavailable integration check with a green unit-test badge.

At `.deploy`, create a fresh plan from the approved immutable configuration and apply that exact saved plan. A much earlier `.noop` is evidence for review, not a guarantee that live state remains unchanged. Inspect unexpected drift before applying; do not regenerate an unrelated plan inside the apply command.

Store the binary plan, JSON view, and text view in a restrictive runner-owned temporary directory. Bind them to the same configuration, variables, backend, workspace, and tool/provider versions. If jobs exchange plans, protect both artifact provenance and confidentiality; never accept a plan uploaded by an untrusted PR job as an authorized apply input.

Saved plans and their JSON views can contain sensitive values even when normal terminal output hides them. Treat them as sensitive artifacts with bounded retention. See [Terraform's saved-plan guidance](https://developer.hashicorp.com/terraform/cli/commands/plan#out-filename).

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
