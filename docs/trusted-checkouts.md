# Trusted Checkouts

`branch-deploy` workflows commonly use the `issue_comment` event so deployment
commands can be driven by pull request comments such as `.noop` and `.deploy`.
That event has an important security property: GitHub evaluates the workflow
file from the repository's default branch, not from the pull request branch.

That protects the workflow definition itself, but it does not automatically
protect code you later check out and execute. If your workflow checks out the
pull request SHA and then runs helper scripts such as `script/deploy`,
`script/ci/update_deploy_msg.py` from that checkout, those helpers are controlled by the pull request until the PR is
reviewed and merged.

A trusted checkout separates those concerns:

- **Trusted checkout**: the default-branch workflow commit. Use this for deployment orchestration and helper scripts.
- **Working checkout**: the exact commit SHA selected by branch-deploy. Use this
  for the application, infrastructure, or other content you intend to deploy.

This tells you which revision each file came from. Code you execute in either checkout can still change both directories and affect later steps on that runner.

## When To Use This Pattern

Use trusted checkouts when your branch-deploy workflow does both of these:

1. checks out pull request content with `steps.branch-deploy.outputs.sha`
2. executes repository-owned helper code after that checkout

Common examples include:

- `script/deploy` or `script/ci/*` helper scripts
- scripts that transform Terraform plan/apply output before branch-deploy posts
  the final deployment comment
- deployment wrappers that set cloud CLI arguments, select targets, or prepare
  credentials

If all deployment logic is inline in the workflow file, and the workflow uses the
`issue_comment` event, you already get the default-branch workflow-file
protection. Trusted checkouts are most useful once deployment behavior moves
into checked-out files.

## Recommended Shape

Use the [four-job workflow](examples.md#hardened-workflow-starting-point) to separate the Branch Deploy request, validation, deployment, and result. In jobs that need both checkouts, use the exact trusted workflow SHA for helpers and Branch Deploy's `sha` output for the candidate. Verify both checkout `HEAD` values before using them.

Run pull request scripts on a fresh runner with only the access they need. Start another clean runner for any job that can publish, report the result, or release a lock. Moving credentials to a later step on the same runner does not isolate them from earlier code.

## Checkout Path Safety

Use separate directories for the two checkouts. A practical convention is:

- trusted checkout directory: derived from `github.event.repository.default_branch`
- working checkout directory: `deployment-${FULL_SHA}`

The trusted directory should be sanitized before use as a filesystem path. The
working directory should be derived only after validating that
`steps.branch-deploy.outputs.sha` is a 40-character Git SHA, or a 64-character
SHA if your organization uses SHA-256 repositories.

The workflow should fail if either derived directory is empty, unsafe, or
collides with the other checkout directory.

## Checkout Hygiene

For both checkouts, prefer shallow checkouts and avoid persisting credentials:

```yaml
with:
  fetch-depth: 1
  persist-credentials: false
```

Use the exact `sha` output from branch-deploy for working code:

```yaml
with:
  ref: ${{ steps.branch-deploy.outputs.sha }}
```

Do not use a mutable branch ref for deployments unless you have a specific reason
to do so. See [Deploying Commit SHAs](deploying-commit-SHAs.md) for more detail.

For the trusted checkout in an `issue_comment` workflow, `github.sha` points to
the last commit on the repository's default branch:

```yaml
with:
  ref: ${{ github.sha }}
```

## Custom Deployment Messages

`deploy_message_path` is a repository-relative path, not a checkout path. Branch Deploy fetches it through GitHub's Contents API at the exact trusted workflow SHA, so a separate trusted checkout is not needed for the template. Use `{{ results }}` for `DEPLOY_MESSAGE`; inserted output is rendered once and template-looking text inside it remains inert. See [Custom Deployment Messages](custom-deployment-messages.md) for the supported grammar.

## Deployment Output Files

Within a trusted job, create an output file under `RUNNER_TEMP` and pass its absolute path to the trusted helper. This avoids an accidental path collision. Code running on that runner can still change the file. For a separate result job, report trusted job outcomes instead of reading a file supplied by the pull request.

```yaml
- name: prepare deployment output path
  id: deployment-output
  run: |
    set -euo pipefail

    output_dir="$(mktemp -d "${RUNNER_TEMP}/branch-deploy-output.XXXXXX")"
    output_path="${output_dir}/deployment-output.txt"
    : > "${output_path}"

    if [[ -L "${output_path}" || ! -f "${output_path}" ]]; then
      echo "deployment output path is not a regular file: ${output_path}" >&2
      exit 1
    fi

    echo "path=${output_path}" >> "${GITHUB_OUTPUT}"
    echo "deployment output path: ${output_path}"
```

Then run the helper from the trusted checkout:

```yaml
- name: update deploy comment
  working-directory: ${{ steps.trusted-path.outputs.trusted_dir }}
  env:
    RESULTS_PATH: ${{ steps.deployment-output.outputs.path }}
  run: python3 script/ci/update_deploy_msg.py
```

## Other Hardening Options

Trusted checkouts work well with other branch-deploy safety settings:

- Set `allow_forks: false` if your project does not need fork deployments.
- Use branch protection, pull request reviews, and required status checks.
- Use `commit_verification: true` if your project requires verified commits.
- Always use the `sha` output for deployment checkouts.

For Terraform or other tools with shared remote state, use GitHub Actions
concurrency to avoid state-lock races. For example:

```yaml
concurrency:
  group: terraform-production
  cancel-in-progress: false
  queue: max
```

Apply that shared group only to jobs that touch the same remote state. Support
commands such as `.help`, `.lock`, `.unlock`, and `.wcid` can use a unique
per-run concurrency group or no concurrency group so they stay responsive.

## Full Terraform Example

See [Terraform with Trusted Checkouts](examples.md#terraform-with-trusted-checkouts) for the branch, merge, and lock-cleanup workflows. Before giving a plan access to providers or remote state, review the [Terraform plan guidance](security_hardening_guides/terraform-plans.md).

Related docs:

- [Deploying Commit SHAs](deploying-commit-SHAs.md)
- [Custom Deployment Messages](custom-deployment-messages.md)
- [Deployment Confirmation](deployment-confirmation.md)
- [Merge Commit Workflow Strategy](merge-commit-strategy.md)
- [Unlock On Merge Mode](unlock-on-merge.md)
