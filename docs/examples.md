# Examples

This section contains real world and common examples of how you could use this Action

> Note: Examples use `uses: grantbirki/branch-deploy@vX.X.X` as a placeholder. Choose a version from [this repository's releases](https://github.com/grantbirki/branch-deploy/releases) that supports the features you use, or pin its full commit SHA.

> **Start here for a new credentialed workflow:** Use the [Hardened Workflow Starting Point](#hardened-workflow-starting-point). The remaining examples explain specific integrations and migration paths. Unless noted otherwise, they may combine admission, pull request code, deployment tooling, and credentials in one job. Treat them as references, not security baselines.

> For comment-triggered deployments, publish only when `continue == 'true'` and `noop == 'false'`. An accepted `.noop` sets both outputs to `true`. If your publish step checks only `continue`, update that condition in your workflow; upgrading Branch Deploy won't change it for you.
>
> For [deploy-on-merge](merge-commit-strategy.md), keep checking `continue == 'true'` alone. That mode doesn't set `noop`.

## Table of Contents

Quick links below to jump to a specific branch-deploy example:

- [Examples](#examples)
  - [Table of Contents](#table-of-contents)
  - [Hardened Workflow Starting Point](#hardened-workflow-starting-point)
  - [Simple Example](#simple-example)
  - [Terraform](#terraform)
  - [Terraform with Trusted Checkouts](#terraform-with-trusted-checkouts)
  - [Heroku](#heroku)
  - [Railway](#railway)
  - [SSH](#ssh)
  - [Cloudflare Pages](#cloudflare-pages)
  - [Cloudflare Workers](#cloudflare-workers)
  - [Multiple Jobs](#multiple-jobs)
  - [Multiple Jobs with GitHub Pages and Hugo](#multiple-jobs-with-github-pages-and-hugo)
  - [Multiple Jobs with GitHub Pages and Astro](#multiple-jobs-with-github-pages-and-astro)
  - [Multiple Jobs with GitHub Environments](#multiple-jobs-with-github-environments)

## Hardened Workflow Starting Point

This is the recommended starting point for a new workflow that uses deployment credentials. It requires Branch Deploy `v12.1.0` or later and pins that release to its full commit SHA. Update both Branch Deploy references together when upgrading.

Before a runner starts, the `branch-deploy` job accepts pull request comments only from a repository `OWNER` or organization `MEMBER`. `COLLABORATOR` is deliberately omitted; add it to the allowlist only if outside collaborators should be able to request deployments. This field describes the commenter's association with the repository, not the pull request head, so Branch Deploy's secure `allow_forks: false` default remains the fork control and the Action still performs its repository-permission and request-admission checks.

The four jobs keep code trust separate from deployment authority:

1. `branch-deploy` evaluates the IssueOps request without checking out pull request code. It has no deployment environment, provider credentials, or OIDC permission.
2. `validate` checks out the exact admitted candidate SHA with read-only repository access. It checks out deployment helpers separately at the exact trusted workflow SHA from Branch Deploy's result context.
3. `deploy` runs only after validation and only for `.deploy`. It checks out the same candidate and trusted SHAs, repeats the fail-closed validation, and gives the deployment token only to the trusted helper step.
4. `result` checks out no code. It reports the selected validation and deployment results through [result mode](result-mode.md).

The example assumes that the protected default branch contains `.github/scripts/validate-candidate` and `.github/scripts/deploy-candidate`. The validation helper must inspect candidate content without executing candidate-controlled tools, providers, hooks, or package scripts. The deployment helper owns credential use and must fail before provider execution when the candidate violates policy.

`.noop` runs `validate` and then `result`; it skips the credentialed `deploy` job. `.deploy` runs all four jobs and accepts only `production` as its target. Fork deployments are disabled, checkouts do not persist credentials, no cache or artifact crosses the boundary, and every candidate checkout uses the exact SHA admitted by Branch Deploy.

```yaml
name: branch-deploy

cache-mode: none

on:
  issue_comment:
    types: [created]

permissions: {}

jobs:
  branch-deploy:
    name: branch-deploy
    if: >-
      ${{
        github.event.issue.pull_request &&
        contains(
          fromJSON('["OWNER", "MEMBER"]'),
          github.event.comment.author_association
        )
      }}
    runs-on: ubuntu-latest
    permissions:
      checks: read
      contents: write
      deployments: write
      pull-requests: write
      statuses: read
    outputs:
      continue: ${{ steps.branch-deploy.outputs.continue }}
      context: ${{ steps.branch-deploy.outputs.context }}
      noop: ${{ steps.branch-deploy.outputs.noop }}
      sha: ${{ steps.branch-deploy.outputs.sha }}
    steps:
      - name: branch-deploy
        id: branch-deploy
        uses: grantbirki/branch-deploy@a7a7ea40a15a79a036322c2924ab74f5eded702c # v12.1.0
        with:
          environment_targets: production
          skip_completing: true

  validate:
    needs: branch-deploy
    if: >-
      ${{ needs.branch-deploy.outputs.continue == 'true' &&
          fromJSON(needs.branch-deploy.outputs.context).run_attempt == github.run_attempt }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: checkout trusted tools
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          ref: ${{ fromJSON(needs.branch-deploy.outputs.context).trusted_sha }}
          path: trusted
          fetch-depth: 1
          persist-credentials: false

      - name: checkout candidate
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          ref: ${{ needs.branch-deploy.outputs.sha }}
          path: candidate
          fetch-depth: 1
          persist-credentials: false

      - name: verify checkouts
        env:
          EXPECTED_CANDIDATE_SHA: ${{ needs.branch-deploy.outputs.sha }}
          EXPECTED_TRUSTED_SHA: ${{ fromJSON(needs.branch-deploy.outputs.context).trusted_sha }}
        run: |
          set -euo pipefail
          test "$(git -C candidate rev-parse HEAD)" = "$EXPECTED_CANDIDATE_SHA"
          test "$(git -C trusted rev-parse HEAD)" = "$EXPECTED_TRUSTED_SHA"

      - name: validate candidate
        env:
          CANDIDATE_DIR: ${{ github.workspace }}/candidate
        run: ./trusted/.github/scripts/validate-candidate "$CANDIDATE_DIR"

  deploy:
    needs: [branch-deploy, validate]
    if: >-
      ${{ needs.branch-deploy.outputs.continue == 'true' &&
          needs.branch-deploy.outputs.noop == 'false' &&
          needs.validate.result == 'success' &&
          fromJSON(needs.branch-deploy.outputs.context).run_attempt == github.run_attempt }}
    runs-on: ubuntu-latest
    environment: production
    concurrency:
      group: branch-deploy-production
      cancel-in-progress: false
    permissions:
      contents: read
    steps:
      - name: checkout trusted tools
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          ref: ${{ fromJSON(needs.branch-deploy.outputs.context).trusted_sha }}
          path: trusted
          fetch-depth: 1
          persist-credentials: false

      - name: checkout candidate
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          ref: ${{ needs.branch-deploy.outputs.sha }}
          path: candidate
          fetch-depth: 1
          persist-credentials: false

      - name: verify checkouts
        env:
          EXPECTED_CANDIDATE_SHA: ${{ needs.branch-deploy.outputs.sha }}
          EXPECTED_TRUSTED_SHA: ${{ fromJSON(needs.branch-deploy.outputs.context).trusted_sha }}
        run: |
          set -euo pipefail
          test "$(git -C candidate rev-parse HEAD)" = "$EXPECTED_CANDIDATE_SHA"
          test "$(git -C trusted rev-parse HEAD)" = "$EXPECTED_TRUSTED_SHA"

      - name: revalidate candidate
        env:
          CANDIDATE_DIR: ${{ github.workspace }}/candidate
        run: ./trusted/.github/scripts/validate-candidate "$CANDIDATE_DIR"

      - name: deploy candidate
        env:
          CANDIDATE_DIR: ${{ github.workspace }}/candidate
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
        run: ./trusted/.github/scripts/deploy-candidate "$CANDIDATE_DIR"

  result:
    needs: [branch-deploy, validate, deploy]
    if: ${{ always() && needs.branch-deploy.outputs.continue == 'true' }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      deployments: write
      pull-requests: write
    steps:
      - name: report result
        uses: grantbirki/branch-deploy@a7a7ea40a15a79a036322c2924ab74f5eded702c # v12.1.0
        with:
          result_mode: true
          context: ${{ needs.branch-deploy.outputs.context }}
          job_results: ${{ needs.branch-deploy.outputs.noop == 'true' && format('["{0}"]', needs.validate.result) || format('["{0}","{1}"]', needs.validate.result, needs.deploy.result) }}
```

This layout does not turn pull request code into trusted code. The trusted helpers still need a repository-specific policy for what candidate content may reach a provider. The deployment environment still needs appropriate reviewers, narrowly scoped secrets, and recovery procedures. For the underlying model, see [Trusted Checkouts](trusted-checkouts.md), [Result Mode](result-mode.md), and the [security hardening guides](security_hardening_guides/README.md).

## Simple Example

This is the simplest possible example of how you could use the branch-deploy Action for reference

> **Reference example:** This compact workflow shows output routing in one job. Because it does not separate admission, pull request code, and deployment credentials, use the [hardened starting point](#hardened-workflow-starting-point) for a new credentialed workflow.

- `.noop` will run the noop deploy step only (you can configure noop deployments however you like, this is just an example)
- `.deploy` will deploy the current branch via the deploy step only (you can configure deployments however you like, this is just an example)

```yaml
name: branch-deploy

on:
  issue_comment:
    types: [created]

# Permissions needed for reacting and adding comments for IssueOps commands
permissions:
  pull-requests: write
  deployments: write
  contents: write
  checks: read
  statuses: read

jobs:
  deploy:
    name: deploy
    runs-on: ubuntu-latest
    if: ${{ github.event.issue.pull_request }} # only run on pull request comments

    steps:
      # The branch-deploy Action
      - name: branch-deploy
        id: branch-deploy
        uses: grantbirki/branch-deploy@vX.X.X

        # If the branch-deploy Action was triggered, checkout our branch
      - uses: actions/checkout@v7.0.0
        with:
          ref: ${{ steps.branch-deploy.outputs.sha }}
          persist-credentials: false

        # If the branch-deploy Action was triggered, run the noop deployment (i.e. '.noop')
      - name: noop deploy
        if: ${{ steps.branch-deploy.outputs.continue == 'true' && steps.branch-deploy.outputs.noop == 'true' }}
        run: <do-your-noop-deployment> # this could be anything you want

        # If the branch-deploy Action was triggered, run the real deployment (i.e. '.deploy')
      - name: deploy
        if: ${{ steps.branch-deploy.outputs.continue == 'true' && steps.branch-deploy.outputs.noop != 'true' }}
        run: <do-your-deployment> # this could be anything you want
```

## Terraform

Start with the [four-job workflow above](#hardened-workflow-starting-point). For `.noop`, inspect the selected commit in `validate` without initializing Terraform or accessing production state. If you need a live plan, first approve that exact commit or enforce a [policy that makes it safe to plan](security_hardening_guides/terraform-plans.md). Run the plan on a separate runner with only the provider, state, and lock access it needs, and no way to obtain apply credentials.

For `.deploy`, recheck the selected commit in the protected `deploy` job, create and review the plan there, then apply that saved plan. Let `result` report the job outcome from a fresh runner. Keep the plan file and raw output out of pull request comments.

## Terraform with Trusted Checkouts

Use the [Terraform guidance above](#terraform) for pull request previews and deployments. The separate workflows below handle a subsequent merge to the default branch and release a sticky lock after merge.

### `.github/workflows/branch-deploy.yml`

Use the [four-job workflow](#hardened-workflow-starting-point) as the branch workflow. It checks out deployment helpers at `context.trusted_sha` and the proposed configuration at Branch Deploy's `sha` output. [Separate checkout directories](trusted-checkouts.md) keep those revisions clear, but code running in either directory can change both. Run pull request code on a different runner from the jobs that can apply changes or post the result.

### `.github/workflows/deploy.yml`

```yaml
name: deploy

on:
  push:
    branches: ["main"]

permissions:
  contents: read
  deployments: write

jobs:
  deployment-check:
    runs-on: ubuntu-latest
    outputs:
      continue: ${{ steps.deployment-check.outputs.continue }}
      sha: ${{ steps.deployment-check.outputs.sha }}

    steps:
      - name: deployment check
        id: deployment-check
        uses: grantbirki/branch-deploy@vX.X.X
        with:
          merge_deploy_mode: true
          environment: production

  deploy:
    if: ${{ needs.deployment-check.outputs.continue == 'true' }}
    needs: deployment-check
    runs-on: ubuntu-latest
    concurrency:
      group: terraform-production
      cancel-in-progress: false
      queue: max
    environment: production
    defaults:
      run:
        working-directory: terraform/
    env:
      TF_IN_AUTOMATION: "true"

    steps:
      - name: checkout
        uses: actions/checkout@v7.0.0
        with:
          ref: ${{ needs.deployment-check.outputs.sha }}
          fetch-depth: 1
          persist-credentials: false

      - name: read terraform version
        id: terraform-version
        working-directory: .
        run: echo "version=$(cat terraform/.terraform-version)" >> "$GITHUB_OUTPUT"

      - name: setup terraform
        uses: hashicorp/setup-terraform@v4
        with:
          terraform_version: ${{ steps.terraform-version.outputs.version }}

      - name: terraform init
        env:
          TF_TOKEN_app_terraform_io: ${{ secrets.TF_API_TOKEN }}
        run: terraform init

      - name: terraform apply
        env:
          TF_TOKEN_app_terraform_io: ${{ secrets.TF_API_TOKEN }}
        run: terraform apply -auto-approve -no-color -compact-warnings
```

### `.github/workflows/unlock-on-merge.yml`

```yaml
name: Unlock On Merge

on:
  pull_request:
    types: [closed]

permissions:
  contents: write

jobs:
  unlock-on-merge:
    runs-on: ubuntu-latest
    if: github.event.pull_request.merged == true

    steps:
      - name: unlock on merge
        id: unlock-on-merge
        uses: grantbirki/branch-deploy@vX.X.X
        with:
          unlock_on_merge_mode: true
          environment_targets: production
```

### `.github/deployment_message.md`

If you include `results`, pass only a summary suitable for everyone who can read the pull request.

````markdown
### Deployment Results {{ ":white_check_mark:" if status === "success" else ":x:" }}

{% if status === "success" %}**{{ actor }}** successfully **{{ "noop" if noop else "branch" }}** deployed branch `{{ ref }}` to **{{ environment }}**{% endif %}{% if status === "failure" %}**{{ actor }}** your **{{ "noop" if noop else "branch" }}** deployment of `{{ ref }}` failed to deploy to the **{{ environment }}** environment{% endif %}

<details><summary>Show Results</summary>

```terraform
{{ results }}
```

</details>
````

## Heroku

This example shows how you could use this Action with [Heroku](https://heroku.com)

- `.noop` skips checkout and does not publish to Heroku.
- `.deploy` publishes the exact commit selected by Branch Deploy to Heroku.

```yaml
name: branch-deploy

on:
  issue_comment:
    types: [created]

permissions:
  pull-requests: write
  deployments: write
  contents: write
  checks: read
  statuses: read

jobs:
  deploy:
    name: deploy
    if: ${{ github.event.issue.pull_request }} # only run on pull request comments
    runs-on: ubuntu-latest
    environment: production-secrets # the locked down environment we pull secrets from

    steps:
      # The branch-deploy Action
      - name: branch-deploy
        id: branch-deploy
        uses: grantbirki/branch-deploy@vX.X.X

      - name: Checkout
        if: steps.branch-deploy.outputs.continue == 'true' && steps.branch-deploy.outputs.noop == 'false'
        uses: actions/checkout@v7.0.0
        with:
          ref: ${{ steps.branch-deploy.outputs.sha }}
          persist-credentials: false

      - name: Deploy to Heroku
        if: steps.branch-deploy.outputs.continue == 'true' && steps.branch-deploy.outputs.noop == 'false'
        uses: AkhileshNS/heroku-deploy@79ef2ae4ff9b897010907016b268fd0f88561820 # pin@v3.12.12
        with:
          heroku_app_name: <your-heroku-app-name-here>
          heroku_email: ${{ secrets.HEROKU_EMAIL }}
          heroku_api_key: ${{ secrets.HEROKU_API_KEY }}
```

## Railway

This example shows how you could use this Action with [Railway](https://railway.app)

- `.noop` skips checkout and does not publish to Railway.
- `.deploy` publishes the exact commit selected by Branch Deploy to Railway.

```yaml
name: branch-deploy

on:
  issue_comment:
    types: [created]

permissions:
  pull-requests: write
  deployments: write
  contents: write
  checks: read
  statuses: read

jobs:
  deploy:
    name: deploy
    if: ${{ github.event.issue.pull_request }} # only run on pull request comments
    runs-on: ubuntu-latest
    environment: production-secrets # the locked down environment we pull secrets from

    steps:
      # The branch-deploy Action
      - name: branch-deploy
        id: branch-deploy
        uses: grantbirki/branch-deploy@vX.X.X

      - name: Checkout
        if: steps.branch-deploy.outputs.continue == 'true' && steps.branch-deploy.outputs.noop == 'false'
        uses: actions/checkout@v7.0.0
        with:
          ref: ${{ steps.branch-deploy.outputs.sha }}
          persist-credentials: false

      - name: Install Railway
        if: steps.branch-deploy.outputs.continue == 'true' && steps.branch-deploy.outputs.noop == 'false'
        run: npm i -g @railway/cli

      - name: Deploy to Railway
        if: steps.branch-deploy.outputs.continue == 'true' && steps.branch-deploy.outputs.noop == 'false'
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
        run: railway up
```

## SSH

This example shows how you could use this Action with SSH

You can define any commands you want to be run in your SSH Action and they would be gated by the branch-deploy Action.

- `.noop` has no effect here (but you could change that)
- `.deploy` runs the SSH action with your branch

> A live example can be found [here](https://github.com/the-hideout/cache/blob/6ee6ee2a69104f165c9f20df6e4e5cbb337b7c54/.github/workflows/branch-deploy.yml)

```yaml
name: branch-deploy

on:
  issue_comment:
    types: [created]

# Permissions needed for reacting and adding comments for IssueOps commands
permissions:
  pull-requests: write
  deployments: write
  contents: write
  checks: read
  statuses: read

jobs:
  deploy:
    environment: production-secrets # the locked down environment we pull secrets from
    if: ${{ github.event.issue.pull_request }} # only run on pull request comments
    runs-on: ubuntu-latest

    steps:
      # The branch-deploy Action
      - uses: grantbirki/branch-deploy@vX.X.X
        id: branch-deploy

        # If the branch-deploy Action was triggered, checkout our branch
      - name: Checkout
        if: ${{ steps.branch-deploy.outputs.continue == 'true' }}
        uses: actions/checkout@v7.0.0
        with:
          ref: ${{ steps.branch-deploy.outputs.sha }}
          persist-credentials: false

        # Deploy our branch via SSH remote commands
      - name: SSH Remote Deploy
        if: ${{ steps.branch-deploy.outputs.continue == 'true' && steps.branch-deploy.outputs.noop != 'true' }}
        uses: appleboy/ssh-action@4a03da89e5c43da56e502053be4bbcb293411883 # pin@v0.1.6
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USERNAME }}
          key: ${{ secrets.SSH_KEY }}
          port: ${{ secrets.SSH_PORT }}
          script_stop: true
          script: <run-some-ssh-commands-here> # this could be whatever you want
```

## Cloudflare Pages

Start with the [four-job workflow above](#hardened-workflow-starting-point). If `.noop` should build the site, add a build job after `validate`. Give it read-only repository access, no Cloudflare token, and no deployment environment. Report the build outcome from `result` on a separate runner.

A [Pages preview URL](https://developers.cloudflare.com/pages/configuration/preview-deployments/) publishes the site. Use `.deploy to development` for that, and reserve `.deploy` for production. Publish from a fresh runner with trusted upload tooling, a fixed project and branch, and a [Pages API token](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/#generate-an-api-token) limited to the intended account. Verify the files belong to the approved commit, and keep candidate install and build scripts out of the publish job.

## Cloudflare Workers

Use the same [separate build, publish, and result jobs](#cloudflare-pages). For `.noop`, build and test the Worker locally in the build job, without a Cloudflare token or access to live bindings.

Use `.deploy to development` to publish a [development Worker](https://developers.cloudflare.com/workers/wrangler/environments/) with bindings isolated from production. In the publish job, use trusted Wrangler tooling and configuration, verify the bundle belongs to the approved commit, and give the Cloudflare token only to the upload step. Run candidate package scripts only in the build job.

## Multiple Jobs

> **Version:** Result mode requires `v12.1.0` or later. Replace `vX.X.X` in both steps below with the same full immutable commit SHA from this repository.

Use [result mode](result-mode.md) to complete a deployment or noop after work in other jobs. The initial job passes its context directly to the result job; the deployment job checks `run_attempt` before doing any work. Pin both Branch Deploy invocations to the same full immutable commit SHA in real workflows.

This example runs the downstream job for both noops and deployments, so `job_results` contains no intentionally skipped jobs. Keep provider calls inside the non-noop step.

```yaml
name: deploy

on:
  issue_comment:
    types: [created]

permissions: {}

jobs:
  trigger:
    if: ${{ github.event.issue.pull_request }}
    runs-on: ubuntu-latest
    permissions:
      checks: read
      contents: write
      deployments: write
      pull-requests: write
      statuses: read
    outputs:
      continue: ${{ steps.branch-deploy.outputs.continue }}
      noop: ${{ steps.branch-deploy.outputs.noop }}
      sha: ${{ steps.branch-deploy.outputs.sha }}
      context: ${{ steps.branch-deploy.outputs.context }}
    steps:
      - uses: grantbirki/branch-deploy@vX.X.X
        id: branch-deploy
        with:
          skip_completing: true

  deploy:
    needs: trigger
    if: >-
      ${{ needs.trigger.outputs.continue == 'true' &&
          fromJSON(needs.trigger.outputs.context).run_attempt == github.run_attempt }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7.0.0
        with:
          ref: ${{ needs.trigger.outputs.sha }}
          persist-credentials: false

      - name: Validate the noop
        if: ${{ needs.trigger.outputs.noop == 'true' }}
        run: echo "Run your deployment validation here without deploying"

      - name: Deploy
        if: ${{ needs.trigger.outputs.noop != 'true' }}
        run: echo "Run your deployment here"

  result:
    needs: [trigger, deploy]
    if: ${{ always() && needs.trigger.outputs.continue == 'true' }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      deployments: write
      pull-requests: write
    steps:
      - uses: grantbirki/branch-deploy@vX.X.X
        with:
          result_mode: true
          context: ${{ needs.trigger.outputs.context }}
          job_results: ${{ toJSON(needs.*.result) }}
          result_url: https://example.com
```

## Multiple Jobs with GitHub Pages and Hugo

`.noop` builds the [Hugo](https://gohugo.io/) site without uploading or publishing it. `.deploy` builds the site and publishes it to [GitHub Pages](https://pages.github.com/). Only the deploy job has permission to publish to Pages.

[Result mode](result-mode.md) reports the build result for a noop and both job results for a deployment. A failed, cancelled, or unexpectedly skipped job is reported as such. Use the same Branch Deploy commit for the trigger and result steps.

```yaml
name: branch deploy

cache-mode: none

on:
  issue_comment:
    types: [created]

permissions: {}

jobs:
  # branch-deploy trigger job
  trigger:
    if: # only run on pull request comments and very specific comment body string as defined in our branch-deploy settings
      ${{ github.event.issue.pull_request &&
      (contains(github.event.comment.body, '.deploy') ||
      contains(github.event.comment.body, '.lock') ||
      contains(github.event.comment.body, '.noop') ||
      contains(github.event.comment.body, '.help') ||
      contains(github.event.comment.body, '.wcid') ||
      contains(github.event.comment.body, '.unlock')) }}
    runs-on: ubuntu-latest
    permissions:
      checks: read
      contents: write
      deployments: write
      pull-requests: write
      statuses: read
    outputs:
      continue: ${{ steps.branch-deploy.outputs.continue }}
      context: ${{ steps.branch-deploy.outputs.context }}
      noop: ${{ steps.branch-deploy.outputs.noop }}
      sha: ${{ steps.branch-deploy.outputs.sha }}
    steps:
      - uses: grantbirki/branch-deploy@7a6af23b802f1284c5bb2f2e42edf79c667c067d # v12.2.0
        id: branch-deploy
        with:
          environment: github-pages
          environment_targets: github-pages
          production_environments: github-pages
          skip_completing: true

  build:
    needs: trigger
    if: >-
      ${{ needs.trigger.outputs.continue == 'true' &&
          fromJSON(needs.trigger.outputs.context).run_attempt == github.run_attempt }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pages: read

    steps:
      # checkout the project's repository based on the commit SHA provided by the branch-deploy step
      - name: checkout
        uses: actions/checkout@v7.0.0
        with:
          ref: ${{ needs.trigger.outputs.sha }}
          persist-credentials: false

      # read the hugo version from the .hugo-version file in this repository
      - name: set hugo version
        id: hugo-version
        run: |
          HUGO_VERSION=$(cat .hugo-version)
          echo "HUGO_VERSION=${HUGO_VERSION}" >> $GITHUB_OUTPUT

      # install the hugo cli using the version detected in the previous step
      - name: install hugo cli
        env:
          HUGO_VERSION: ${{ steps.hugo-version.outputs.HUGO_VERSION }}
        run: |
          wget -O ${{ runner.temp }}/hugo.deb https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_${HUGO_VERSION}_linux-amd64.deb \
          && sudo dpkg -i ${{ runner.temp }}/hugo.deb

      # configure the GitHub Pages action
      - name: setup pages
        id: pages
        uses: actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0

      # build the site with hugo
      - name: build with hugo
        env:
          BASE_URL: ${{ steps.pages.outputs.base_url }}
        run: |
          hugo --gc --verbose \
            --baseURL "$BASE_URL"

      # upload the built site as an artifact for the deploy step
      - name: upload artifact
        if: ${{ needs.trigger.outputs.noop == 'false' }}
        uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
        with:
          path: ./public

  # deploy to GitHub Pages
  deploy:
    needs: [trigger, build]
    if: >-
      ${{ needs.trigger.outputs.continue == 'true' &&
          needs.trigger.outputs.noop == 'false' &&
          fromJSON(needs.trigger.outputs.context).run_attempt == github.run_attempt }}
    permissions:
      pages: write
      id-token: write
    outputs:
      page_url: ${{ steps.deployment.outputs.page_url }}
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest

    steps:
      # deploy the site to GitHub Pages
      - name: deploy
        id: deployment
        uses: actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1

  result:
    needs: [trigger, build, deploy]
    if: ${{ always() && needs.trigger.outputs.continue == 'true' }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      deployments: write
      pull-requests: write
    steps:
      - uses: grantbirki/branch-deploy@7a6af23b802f1284c5bb2f2e42edf79c667c067d # v12.2.0
        with:
          result_mode: true
          context: ${{ needs.trigger.outputs.context }}
          # A noop requires only build. For a deploy, report both jobs even if one was skipped.
          job_results: >-
            ${{ needs.trigger.outputs.noop == 'true' &&
                format('["{0}"]', needs.build.result) ||
                format('["{0}","{1}"]', needs.build.result, needs.deploy.result) }}
          result_url: ${{ needs.deploy.outputs.page_url }}
```

## Multiple Jobs with GitHub Pages and Astro

`.noop` builds the [Astro](https://astro.build/) site without uploading or publishing it. `.deploy` builds the site and publishes it to [GitHub Pages](https://pages.github.com/). This example assumes an npm project configured for its Pages URL, with a `build` script that writes the site to `dist/`.

[Result mode](result-mode.md) reports the build result for a noop and both job results for a deployment. A failed, cancelled, or unexpectedly skipped job is reported as such. Use the same Branch Deploy commit for the trigger and result steps.

```yaml
name: branch deploy

cache-mode: none

on:
  issue_comment:
    types: [created]

permissions: {}

jobs:
  # branch-deploy trigger job
  trigger:
    if: # only run on pull request comments and very specific comment body string as defined in our branch-deploy settings
      ${{ github.event.issue.pull_request &&
      (contains(github.event.comment.body, '.deploy') ||
      contains(github.event.comment.body, '.lock') ||
      contains(github.event.comment.body, '.noop') ||
      contains(github.event.comment.body, '.help') ||
      contains(github.event.comment.body, '.wcid') ||
      contains(github.event.comment.body, '.unlock')) }}
    runs-on: ubuntu-latest
    permissions:
      checks: read
      contents: write
      deployments: write
      pull-requests: write
      statuses: read
    outputs:
      continue: ${{ steps.branch-deploy.outputs.continue }}
      context: ${{ steps.branch-deploy.outputs.context }}
      noop: ${{ steps.branch-deploy.outputs.noop }}
      sha: ${{ steps.branch-deploy.outputs.sha }}
    steps:
      - uses: grantbirki/branch-deploy@7a6af23b802f1284c5bb2f2e42edf79c667c067d # v12.2.0
        id: branch-deploy
        with:
          environment: github-pages
          environment_targets: github-pages
          production_environments: github-pages
          skip_completing: true

  build:
    needs: trigger
    if: >-
      ${{ needs.trigger.outputs.continue == 'true' &&
          fromJSON(needs.trigger.outputs.context).run_attempt == github.run_attempt }}
    runs-on: ubuntu-latest
    permissions:
      contents: read

    steps:
      - name: checkout
        uses: actions/checkout@v7.0.0
        with:
          ref: ${{ needs.trigger.outputs.sha }}
          persist-credentials: false

      - name: build with astro
        run: |
          npm ci
          npm run build

      - name: upload artifact
        if: ${{ needs.trigger.outputs.noop == 'false' }}
        uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
        with:
          path: ./dist

  # deploy to GitHub Pages
  deploy:
    needs: [trigger, build]
    if: >-
      ${{ needs.trigger.outputs.continue == 'true' &&
          needs.trigger.outputs.noop == 'false' &&
          fromJSON(needs.trigger.outputs.context).run_attempt == github.run_attempt }}
    permissions:
      pages: write
      id-token: write
    outputs:
      page_url: ${{ steps.deployment.outputs.page_url }}
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest

    steps:
      # deploy the site to GitHub Pages
      - name: deploy
        id: deployment
        uses: actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1

  result:
    needs: [trigger, build, deploy]
    if: ${{ always() && needs.trigger.outputs.continue == 'true' }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      deployments: write
      pull-requests: write
    steps:
      - uses: grantbirki/branch-deploy@7a6af23b802f1284c5bb2f2e42edf79c667c067d # v12.2.0
        with:
          result_mode: true
          context: ${{ needs.trigger.outputs.context }}
          # A noop requires only build. For a deploy, report both jobs even if one was skipped.
          job_results: >-
            ${{ needs.trigger.outputs.noop == 'true' &&
                format('["{0}"]', needs.build.result) ||
                format('["{0}","{1}"]', needs.build.result, needs.deploy.result) }}
          result_url: ${{ needs.deploy.outputs.page_url }}
```

## Multiple Jobs with GitHub Environments

Start with the [four-job workflow](#hardened-workflow-starting-point). Put the GitHub environment that holds deployment credentials only on `deploy`. An accepted `.noop` runs `validate`, skips `deploy` entirely, and finishes in `result` on a fresh runner without checking out the pull request.

[Result mode](result-mode.md) handles completion and lock cleanup. If you maintain a workflow that still [completes deployments manually](../README.md#manual-deployment-control), the excerpts below show how to release only the original non-sticky lock. Keep both steps in trusted jobs, separate from the runner that processes pull request code.

Capture the lock in the start job, after the step with `id: branch-deploy`.

```yaml
    outputs:
      lock_ref_sha: ${{ steps.capture-lock.outputs.sha }}

    steps:
      # Run Branch Deploy with skip_completing: true before this step.
      - name: Capture deployment lock
        id: capture-lock
        if: ${{ steps.branch-deploy.outputs.continue == 'true' }}
        env:
          ENVIRONMENT: ${{ steps.branch-deploy.outputs.environment }}
          GH_REPO: ${{ github.repository }}
          GH_TOKEN: ${{ github.token }}
        run: |
          lock_branch="$(printf '%s' "$ENVIRONMENT" | jq -Rsr 'gsub("\\s"; "-")')-branch-deploy-lock"
          if lock_ref_sha="$(gh api --method GET "repos/{owner}/{repo}/git/ref/heads/${lock_branch}" --jq '.object.sha' 2>/dev/null)"; then
            printf 'sha=%s\n' "$lock_ref_sha" >> "$GITHUB_OUTPUT"
          else
            echo "::warning::Could not capture the original deployment lock; manual lock cleanup will be skipped"
          fi
```

In the completion job, take `LOCK_REF_SHA`, `LOCK_ACTOR`, `ENVIRONMENT`, `ISSUE_NUMBER`, and `COMMENT_ID` from the trusted start job or event, and set `GH_REPO` and `GH_TOKEN` for this repository. The final update fails safely if the lock has changed.

```yaml
    steps:
      - name: Remove Non-Sticky Lock
        id: remove-lock
        run: |
          if [ -z "${LOCK_REF_SHA}" ]; then
            echo "No captured deployment lock remains"
            exit 0
          fi

          lock_branch="$(printf '%s' "$ENVIRONMENT" | jq -Rsr 'gsub("\\s"; "-")')-branch-deploy-lock"
          lock_contents="$(gh api --method GET "repos/{owner}/{repo}/contents/lock.json?ref=${LOCK_REF_SHA}" --jq '.content' | base64 --decode)"
          lock_link="${GITHUB_SERVER_URL}/${GH_REPO}/pull/${ISSUE_NUMBER}#issuecomment-${COMMENT_ID}"

          if ! printf '%s' "$lock_contents" | jq -e \
            --arg actor "$LOCK_ACTOR" \
            --arg environment "$ENVIRONMENT" \
            --arg link "$lock_link" \
            '.created_by == $actor and .environment == $environment and .global == false and .sticky == false and .link == $link' >/dev/null; then
            echo "The captured deployment lock is sticky or belongs to another deployment"
            exit 0
          fi

          repository_id="$(gh api --method GET 'repos/{owner}/{repo}' --jq '.node_id')"
          if gh api graphql \
            -f query='mutation($repository: ID!, $name: GitRefname!, $before: GitObjectID!) { updateRefs(input: {repositoryId: $repository, refUpdates: [{name: $name, beforeOid: $before, afterOid: "0000000000000000000000000000000000000000"}]}) { clientMutationId } }' \
            -f repository="$repository_id" \
            -f name="refs/heads/${lock_branch}" \
            -f before="$LOCK_REF_SHA" >/dev/null; then
            echo "Removed the original deployment lock"
          else
            echo "::warning::The original deployment lock changed; leaving the current lock in place"
          fi
```

---

Are you using the `branch-deploy` Action and want your example included here? Open a pull request and we'll add it!
