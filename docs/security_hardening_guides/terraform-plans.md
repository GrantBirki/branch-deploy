# Terraform plans and provider integrity

Terraform configuration is an input to executable providers, data sources, backend clients, and expression evaluation. A `.noop` should skip apply, but a plan may still read credentials, state, local files, and remote services. Provider code can perform arbitrary operations under its process identity.

Start by deciding which configuration may be evaluated before review. Branch Deploy does not ship a general Terraform configuration sandbox. The policy described here belongs to the consumer workflow and must run from protected code before initialization or credential access.

## Three permission decisions

Keep these questions separate:

1. May this candidate configuration run a plan with the available authority?
2. May this provider, dependency, or tooling change run at all?
3. May the resulting saved plan mutate infrastructure or state?

An approval for one question does not automatically answer the others. For example, a provider update can require approval before `.noop`, while an ordinary literal setting change can remain previewable without approval. Both still need the normal deployment review before apply.

## A practical unapproved-plan policy

Choose the smallest configuration subset that supports ordinary work. This example is a design starting point, not a universal safe allowlist:

| Candidate change | Suggested treatment before credentials |
| --- | --- |
| Literal values or lists in already-reviewed resource attributes | Permit if the provider's plan/refresh behavior for those attributes is understood. |
| Existing YAML or JSON inputs | Permit data edits only through existing trusted paths and expression forms; inspect how the provider consumes the data. |
| New resource of an already-reviewed type | Permit only where its plan-time behavior and allowed attributes have been reviewed. |
| Literal declarative import | Permit a preview only after checking identity, scope, and the provider's import/read behavior. Apply still changes state. |
| Provider package, provider settings, lockfile, tool version, backend, or workspace | Require current-commit approval and protected validation of the change. |
| New data source, module, function, output, file read, secret reference, or unsupported expression | Require explicit review before evaluation, or reject under the consumer's policy. |
| Changed or removed lifecycle protections | Require review; compare the old and new configuration, including deletions. |
| Invalid structure, unexpected symlink, or path escape | Reject outright; approval does not repair an input the checker cannot safely inspect. |

Resource type alone is not enough. An attribute that selects an endpoint, file, command, or template may change plan-time behavior even when its value is a plain string. New imports can cause reads broader than the one object shown in configuration. Document those properties when admitting a provider capability.

Keep the policy about behavior rather than a second inventory of resource names and IDs. Routine configuration changes should not require editing lists of production values in tests or docs. A new capability with different execution or permission behavior deserves a separate policy review.

## Freeze executable controls, then inspect every input

Before unapproved planning, compare the selected configuration against a trusted baseline for controls such as provider sources, versions, checksums, CLI configuration, backend/workspace selection, variable declarations carrying credentials, and approved file-reading expressions. A change outside the supported subset should produce a specific explanation and stop or require review.

Inspect everything Terraform can load, not just the filenames that were convenient to compare:

- All root `.tf` and `.tf.json` files, including added files and declarations using syntax variations such as unquoted block labels.
- `override.tf`, `override.tf.json`, and matching override filenames. Terraform gives these special merging behavior; a later file can alter earlier provider or backend configuration. See [override files](https://developer.hashicorp.com/terraform/language/files/override).
- Automatic variable files, explicit `-var-file` arguments, `TF_VAR_*`, `TF_CLI_ARGS*`, and input chosen by the wrapper.
- CLI configuration, provider development overrides, plugin search paths, inherited environment, and preexisting `.terraform` contents.
- Local and remote modules, referenced data files, symlinks, generated files, and any commands embedded in supported provider features.
- Providers and configuration needed by existing state, including objects removed from the candidate configuration.

`terraform validate` checks Terraform configuration validity. It does not enforce your deployment trust policy and can start providers while validating their schemas. `terraform init -backend=false` avoids initializing the configured backend; it does not make candidate providers safe to load later.

Prefer a maintained HCL parser for a broad language policy. A small dependency-free checker must define a deliberately restricted language, consume the entire input, and reject unsupported syntax. A regular expression that extracts recognized blocks and ignores everything else is not a safe admission check. Test comments, escapes, nesting, Unicode offsets, duplicate declarations, alternate filenames, and content after a valid block.

Never silently fall back to permissive evaluation after a parse error. Avoid turning an incomplete parser into a general HCL interpreter one exception at a time.

## A built-in data source can bypass a provider-only check

`terraform_remote_state` uses Terraform's built-in provider, so adding it does not require a new downloaded provider or a new provider lockfile entry. It can read through a configured backend. An unchanged lockfile therefore does not establish that a PR cannot make new requests. This follows from [the documented built-in provider behavior](https://developer.hashicorp.com/terraform/language/state/remote-state-data).

For an isolated regression test, use a fake local HTTP backend. This is a **negative-test fixture**, not recommended production configuration:

```hcl
data "terraform_remote_state" "probe" {
  backend = "http"
  config = {
    address  = "http://127.0.0.1:18080/state"
    username = "fixture"
    password = "test-only-not-a-secret"
  }
}
```

The fixture illustrates how candidate HCL can select both a destination and authentication data. In an unsafe configuration, an expression could instead refer to a credential-bearing variable already supplied to the process. The [HTTP backend](https://developer.hashicorp.com/terraform/language/backend/http) defines these authentication fields.

A meaningful test runs in a disposable local backend with no production environment variables, starts a loopback-only listener, and uses dummy credentials. First establish that Terraform would make the request without the guard. Then establish that the trusted guard rejects the same candidate before any credential-fetch stub or backend request runs. Do not demonstrate the problem against an external collection endpoint or real state.

## Approval must cover the executed commit

For a consumer that permits otherwise-restricted changes after review, verify all of the following from trusted tooling:

- The PR is open and belongs to the expected repository and base.
- Its current head equals the immutable candidate SHA selected for this run.
- Current repository review policy is satisfied, including code-owner requirements where configured.
- An eligible, non-dismissed approval covers that candidate SHA; an old approval of another commit is insufficient for an exact-commit policy.
- Required CI and base-freshness requirements pass for the same candidate.

Do not treat a single historical `APPROVED` event, a label, or a check name as sufficient evidence. Recheck after a new push, base update, queued wait, or rerun as needed. On missing or inconsistent API data, fail closed.

This exact-commit policy is a consumer restriction. Check [Branch Deploy's actual prechecks](../../src/functions/precheck-gates.ts) and configured modes instead of assuming every invocation enforces it. Stable-branch and explicitly enabled SHA deployments have different semantics; [SHA deployments](../sha-deployments.md) must not become a shortcut around the admission policy.

## Providers are executable dependencies

Treat provider upgrades like executable code review. A provider package can use whatever credentials its process receives. A matching checksum proves bytes match an expected digest; it is not independent provenance when the same PR can replace the package and the expected digest.

Two useful installation policies are:

| Policy | Benefit | Operational cost |
| --- | --- | --- |
| Install only packages selected by protected default-branch policy | Candidate code cannot choose a new executable dependency. | Provider upgrades need a protected-policy rollout before their new behavior can be exercised. |
| Allow reviewed candidate upgrades verified by protected tooling | The upgraded provider can be planned and deployed before merge. | The verifier must independently bind the artifact to an accepted release producer and exact reviewed commit. |

For the second policy, run verification before Terraform initialization or provider loading. Enforce trusted provider identities and release policy, package checksums, expected platform, and any required signatures or attestations. Verify the expected source repository, workflow identity, release/tag or source commit, and artifact digest according to the publisher's provenance format. A valid signature from the wrong producer is insufficient.

Keep verification policy, allowed publishers, and executable verification code on the protected revision. Let a focused upgrade PR change only the intended version selection, lockfile, packages, and corresponding release evidence. Do not permit the same PR to redefine what counts as a trusted publisher for its own verification.

Use the configured verifier's supported trust management. A new checked-in certificate-root snapshot or custom download protocol creates an update burden; add one only for a defined requirement and with a refresh process. If verification fetches public trust metadata, describe that honestly as networked verification even when installation uses only local packages.

Review more than the release's new features: authentication defaults, provider identity, schema/state upgrades, refresh, import, update, and deletion behavior can change an otherwise unchanged root. A successful package verification says nothing about those semantics. Use offline lifecycle tests where possible and a reviewed live plan for the actual managed state.

### Native local installation

Use Terraform's filesystem mirror support for vendored releases. `terraform init -plugin-dir=...` restricts provider installation to a local directory; a trusted static CLI configuration can instead define a `filesystem_mirror`. Retain `-lockfile=readonly`. Missing packages or checksums should fail, not trigger a fallback. See [initialization options](https://developer.hashicorp.com/terraform/cli/commands/init#plugin-installation).

Do not combine readonly installation with `-upgrade`. Prepare intentional lockfile changes in the upgrade PR, including the platforms the consumer supports.

For an exclusive mirror, omit `direct` or exclude the mirrored providers from it. Keep `dev_overrides` out of production: it bypasses the normal version/checksum selection for those providers. Keep plugin-cache directories separate from mirrors. See [CLI installation configuration](https://developer.hashicorp.com/terraform/cli/config/config-file#provider-installation).

`TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE=false` is a trap: Terraform treats nonempty values other than `0` as enabled. Leave this escape hatch unset, or use documented `0` where an environment value is required, and ensure the trusted CLI configuration does not enable it separately. [Terraform documents the exact semantics](https://developer.hashicorp.com/terraform/cli/config/config-file#allowing-the-provider-plugin-cache-to-break-the-dependency-lock-file).

Use fresh runner-owned Terraform data and home directories where practical, a trusted CLI config, and a controlled environment. Account for inherited plugin caches, `TF_CLI_ARGS*`, proxy settings, and credential helpers rather than assuming one CLI flag overrides every input.

Offline provider installation does not make Terraform execution offline: backend access, refresh, data sources, remote modules, and provenance verification are separate network paths. Test installation in isolation and state exactly which component was denied network access.

### Keep upgrades small

Keep the provider version and integrity data in the normal configuration, lockfile, and release artifacts. Derive tooling expectations from those inputs where safe. Tests should assert mismatched digests, wrong producers, missing platforms, or policy changes are rejected; they should not need edits whenever a valid provider version changes.

Prefer the existing runner platform and local installation format over an extra operating-system job or custom mirror generator solely to prove installation works. Add isolation only where it verifies a real property the existing test cannot prove.

### Source-address changes are state migrations

Changing a provider version and changing its source address are different operations. A local mirror can preserve the existing source address; vendoring alone does not require renaming it. If the source address does change, inspect the provider identities recorded in state and plan a separately authorized migration using Terraform's supported tooling. See [provider replacement in state](https://developer.hashicorp.com/terraform/cli/commands/state/replace-provider).

Confirm backend/workspace identity, protect a recovery snapshot, coordinate concurrent runs, and verify that old and new workflow revisions cannot operate against incompatible assumptions during the transition. Do not infer that a schema-compatible provider binary makes the state migration unnecessary, or that opening an upgrade PR authorizes rewriting remote state.

## Credentials: describe the authority actually available

A plan can use a separate read-oriented identity where the provider and backend support it. The credential issuer must prevent that job from acquiring the write identity as well; separate secret names alone do not create a boundary. Backend reads, state locking, and provider refresh may need different permissions, so verify them rather than promising a universally read-only token.

Some consumers retain shared plan/apply credentials. In that model, skipping apply is a control-flow rule, not a reduction in credential authority. Document that limitation and rely on the reviewed admission policy without claiming the plan is a security sandbox. Changing credentials is an independent operational decision, not a hidden prerequisite for a documentation or workflow cleanup.

Read-oriented credentials still expose whatever data they can read. Keep secret-bearing files out of checkouts, artifacts, and caches; restrict access, mask logs, and remove them during cleanup. Limit inherited environment for every process. Avoid exporting credentials through general-purpose outputs or result comments.
