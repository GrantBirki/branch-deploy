# Security hardening guides

## TLDR

- Terraform plans run code and can access credentials. Skipping apply does not make a PR safe to run.
- These guides explain how to check PR changes, protect deployment credentials, and verify what actually happened.
- Use the examples and failure tests to add these checks to your own Branch Deploy workflows.

## How to use these guides

These notes help maintainers and coding agents review Terraform workflows built around `GrantBirki/branch-deploy`. They explain where trust changes, which controls belong to the consumer workflow, and what evidence demonstrates that a deployment worked. The examples are generic and use no production infrastructure or credentials.

Start with the workflow you actually run. A command named `.noop`, an approved PR, or a successful Actions run each proves something different. None proves that arbitrary code can safely run with deployment credentials.

## Reading order

| Guide | Questions it answers |
| --- | --- |
| [Workflow trust boundaries](workflow-boundaries.md) | Who can request work? Which commit supplies executable code? What can caches, artifacts, runners, and job tokens expose? |
| [Terraform plans and provider integrity](terraform-plans.md) | When can an unapproved PR plan? What must stay trusted? How can provider upgrades remain reviewable without weakening installation checks? |
| [Rollout, results, and recovery](rollout-and-recovery.md) | How do you apply the intended plan, introduce new protected tooling, interpret merge-time skips, and recover without bypassing safeguards? |
| [Contributing notes](CONTRIBUTING.md) | How do you add a public-safe finding, example, source, or regression recipe? |

For the Action's exact inputs and current behavior, use [action.yml](../../action.yml), [usage](../usage.md), [trusted checkouts](../trusted-checkouts.md), and [result mode](../result-mode.md). These guides supplement those references; they do not define new Action inputs or automatically enable a Terraform policy.

## Implementation recipes

These recipes explain their assumptions, step order, synthetic examples, failure cases, and limitations. Adapt them to the consumer's pinned tools and authority model; they are not claims that a particular deployment has been tested.

| Recipe | Implementation decision |
| --- | --- |
| [Order checks before Terraform](workflow-boundaries.md#recipe-order-the-checks-before-terraform) | Which inputs must be admitted before dependencies, backend access, or credentials are used? |
| [Preserve failures during reporting](rollout-and-recovery.md#recipe-keep-reporting-from-hiding-failure) | How can diagnostics run without turning failed Terraform work into success? |
| [Constrain baseline expressions](terraform-plans.md#recipe-constrain-expressions-even-when-they-match-the-baseline) | How can existing data-file edits remain previewable without approving every unchanged expression? |
| [Limit credential exposure](workflow-boundaries.md#recipe-give-credentials-only-to-their-intended-process) | How are secrets parsed, stored, passed to Terraform, and removed? |
| [Adopt existing objects](terraform-plans.md#recipe-adopt-an-existing-object-without-taking-over-unrelated-fields) | How are identity, partial ownership, imports, and deletion protections reviewed? |
| [Diagnose a runner without deploying](rollout-and-recovery.md#optional-recipe-diagnose-a-runner-without-deploying) | How can protected configuration verify real access without applying or satisfying a deployment gate? |
| [Select write authority from a saved plan](terraform-plans.md#optional-recipe-derive-write-authority-from-the-saved-plan) | When supported, how can credential scope follow the approved mutations without a broad fallback? |

## The trust model

Separate these decisions before choosing a workflow layout:

1. **Invocation:** may this person request this operation in this repository?
2. **Code admission:** may this exact candidate commit be evaluated with the credentials and network access the job has?
3. **Execution:** which workflow, scripts, tools, providers, configuration, state, and artifacts actually run?
4. **Mutation:** does this operation have permission to change infrastructure or state?
5. **Evidence:** what proves the selected work completed, and what remains untested?

Branch Deploy supplies command handling, repository checks, deployment records, and locking. The consumer supplies the Terraform execution policy. Moving a dangerous command behind Branch Deploy does not change what that command can access.

## Threats these guides cover

Assume an attacker can propose a PR, edit its files, and place misleading text in comments or tool output. Depending on the repository, the attacker might also have permission to push a same-repository branch. A legitimate maintainer can request a plan on that branch without intending to approve every executable input it contains.

The protected default branch, chosen Action commits, and credential issuer are trust anchors in these patterns. Compromise of those anchors, or a reviewer knowingly approving malicious code, requires additional controls. Keep those limits visible rather than describing a workflow as universally safe.

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Passing static CI | The tested revision passed those checks. | Production parity or safe credential use. |
| Current-commit approval | Review policy permits that revision. | That a provider or script is harmless. |
| Successful `.noop` | The selected preview path completed. | That the job lacked write authority or ran new PR-only workflow code. |
| Zero-change plan | Terraform proposed no changes for that run. | That no code ran or no data was read. |
| Successful saved-plan apply | The recorded plan was applied. | That every later refresh will be identical. |
| Successful merge workflow | That workflow completed or deliberately skipped work. | That another apply happened. |

## Keep the implementation small

Use existing Branch Deploy controls and Terraform installation mechanisms before adding wrappers. Keep policy in protected code, resource values in configuration, and volatile inventory out of docs and tests. Add a test when it protects behavior, not merely to repeat a current version or resource ID.

The snippets here are **fragments or synthetic fixtures**, not complete production workflows. Each consumer must supply its own verified Action pins, backend policy, provider permissions, and review requirements. Do not copy a partial example and assume it has configured the rest.

## Scope and provenance

These notes are maintained in [GrantBirki/branch-deploy](https://github.com/GrantBirki/branch-deploy). Documentation changes should target this fork. They do not imply an upstream contribution or compatibility guarantee for another fork.

Public examples should cite the exact change they demonstrate. The [comment-author gate in GrantBirki/software#43](https://github.com/GrantBirki/software/pull/43) is one such example; [its analysis](workflow-boundaries.md#public-example-restricting-comment-authors) deliberately distinguishes that one-line change from a full workflow security review.

Before adding material, read [the contribution rules](CONTRIBUTING.md). Keep private incident histories, repository identities, provider implementations, credentials, and infrastructure details out of the entire change, including Git metadata.
