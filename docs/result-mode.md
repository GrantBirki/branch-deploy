# Completing deployments across jobs

Use result mode to finish a deployment or noop after its work runs in other jobs. The initial invocation still performs deployment checks and acquires the lock when locking is enabled. The result invocation handles completion statuses, comments, reactions, labels, and safe lock cleanup. Existing single-job workflows are unchanged: `result_mode` defaults to `false`.

See the complete [multiple-jobs example](examples.md#multiple-jobs).

## Connect the jobs

Set `skip_completing: true` on the initial invocation. Forward its `context` output directly through the trigger job, alongside the `continue`, `noop`, and `sha` outputs used by your deployment jobs. The context is one JSON object containing the original operation's metadata and `run_attempt`; do not construct or edit it yourself.

Every downstream job that performs deployment work must check the original attempt before running:

```yaml
if: >-
  ${{ needs.trigger.outputs.continue == 'true' &&
      fromJSON(needs.trigger.outputs.context).run_attempt == github.run_attempt }}
```

This prevents a partial rerun from deploying with admission results from an earlier attempt. Rejecting stale context only in the final job would be too late.

Use a separate result job after all jobs whose results should count:

```yaml
result:
  needs: [trigger, deploy]
  if: ${{ always() && needs.trigger.outputs.continue == 'true' }}
  runs-on: ubuntu-latest
  permissions:
    contents: write
    deployments: write
    pull-requests: write
  steps:
    - uses: github/branch-deploy@vX.X.X
      with:
        result_mode: true
        context: ${{ needs.trigger.outputs.context }}
        job_results: ${{ toJSON(needs.*.result) }}
```

The examples use `vX.X.X` as a placeholder. Pin the initial and result invocations to the same full immutable commit SHA in real workflows. Do not check out or execute pull request code in the result job.

## Select job results and handle noops

`job_results` must be a nonempty JSON array containing only `success`, `failure`, `cancelled`, or `skipped`. `toJSON(needs.*.result)` selects those status strings; do not pass the full `needs` or `github` object. Include every required job, but leave intentionally skipped optional jobs out of this selection.

The outcome is chosen in this order: `cancelled`, then `failure`, then `skipped`, then `success`. Any non-success outcome fails the result job after reporting. A skipped job is not silently treated as success.

For noops, run validation without invoking your deployment provider. The example keeps the downstream job running for both modes and guards its individual steps with `noop`. If your workflow skips an entire deployment job for noops, select only the jobs that are required for that noop; do not replace skipped results with success. Result mode completes noop comments, reactions, and labels without creating a deployment or deployment status.

## Completion settings and links

`result_inherit_settings` defaults to `true`: completion uses the initial invocation's custom message path, label settings, and comment URL preference. With `result_inherit_settings: false`, it uses the result invocation's normal completion inputs and their defaults instead. This replaces the inherited settings as a group; omitted values do not fall back to the initial invocation.

`result_url` optionally replaces the final deployment URL with an HTTPS link. Credentials and control characters are rejected. The Action uses the URL for display and never fetches it. An empty value keeps the inherited URL, or uses the result job's `environment_urls` mapping when inheritance is disabled. This input does not select a deployment target or authorize deployment work. The normal `environment_url_in_comment` setting still controls automatic links in the final comment.

Set `DEPLOY_MESSAGE` in the result job for additional result text. Custom templates are loaded from the original trusted workflow SHA, not the pull request checkout. Keep this text and the context free of secrets; do not dump unrelated job outputs into them.

Result mode creates a separate final comment and leaves the original started comment intact.

## Trust, cancellation, and recovery

Pass context only from the original trusted start job's output. Do not load it from pull request files, artifacts, or untrusted build output. Result mode validates the original operation and supports only the same workflow run and attempt; it is not a replay or repair API. New deployment work requires fresh admission, not a rerun of downstream jobs with old context.

Use one finalizer per context. Context is not an authentication token or a signed attestation, and API writes do not provide an exactly-once guarantee. Noop readiness depends on the trusted starting job's output because no deployment record exists for a noop.

Cancellation retains the lock. Other outcomes can release only the original unchanged non-sticky environment lock; sticky, global, and replacement locks are never deleted. A missing lock is not permission to remove a different one.

Failure of the result job can mean either unsuccessful deployment work or a completion/reporting error. Inspect the selected job results and deployment records before deciding that the deployment itself failed or retrying it. `always()` lets the final job run after ordinary failures and cancellations, but force-cancellation, runner loss, or a final job that never starts can prevent completion. Those cases need manual inspection of the deployment and current lock before recovery.

`deployment_result` reports the selected job outcome after the original operation is verified. It remains `success` if the deployment jobs succeeded but reporting or cleanup failed. The existing structured `result` output retains schema version 1 and uses operation `result` with these reason codes:

| Reason code | Meaning |
| --- | --- |
| `result_completed` | Selected jobs succeeded and completion finished. |
| `result_non_success` | Completion finished, but a selected job failed, was cancelled, or was skipped. |
| `invalid_result_context` | Context was malformed or did not match the original operation. No completion writes were made. |
| `invalid_result_inputs` | Results or completion inputs were invalid. No completion writes were made. |
| `result_verification_failed` | GitHub records could not be read to verify the original operation. No completion writes were made. |
| `result_completion_failed` | Reporting or cleanup did not finish. Inspect the existing deployment, final comment, and original lock before manual recovery. |

## Keep manual completion when needed

`skip_completing: true` without a result invocation remains the manual escape hatch. Your workflow then owns final statuses, comments, reactions, labels, and safe non-sticky lock cleanup. See [manual deployment control](../README.md#manual-deployment-control) and the remaining [manual multi-job examples](examples.md#multiple-jobs-with-github-pages-and-hugo).
