# Terraform plans and provider integrity

## TLDR

- A `.noop` runs provider code. That code can use the credentials and network access available to the process.
- Let routine settings changes plan before review only when trusted checks limit what they can do. Require approval for provider changes.
- Verify provider packages before running them, and check an existing object's identity and ownership before importing it.
- Use imports for existing objects. New resources do not need imports, and completed imports can be removed after verification.
- Keep routine edits small. Test the unsafe behavior a check prevents without copying today's resource inventory into tests.

## Why plans need checks

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

## Recipe: keep security checks maintainable

Use this recipe when ordinary Terraform edits repeatedly require changes to guard code, tests, and documentation. Repeated policy copies can disagree, and exceptions added to satisfy each new PR can weaken the original restriction. The goal is one clear rule for each security decision, with tests that show the rule still works. This is consumer design guidance, not an additional Branch Deploy feature or a change to this Action's own test requirements.

Start by tracing one supported unapproved plan and one rejected candidate through the actual workflow. Identify which protected code admits the configuration, verifies executable dependencies, obtains credentials, and selects the saved plan for apply. Record what each check prevents before deleting or combining it. Checks at different trust boundaries may look similar but protect different inputs.

### Keep facts with their owner

| Fact | Authoritative place | Maintenance rule |
| --- | --- | --- |
| Resource names, IDs, settings, and import targets | Terraform configuration and its reviewed data files | Validate structure and relationships without maintaining a second inventory. |
| Selected dependency versions and package digests | The consumer's version constraints, lockfile, and release evidence | Derive consistency checks from those inputs; keep independent producer verification. |
| Allowed publishers, backend identity, supported syntax, and review policy | Protected configuration or tooling | Candidate input cannot redefine the policy used to approve itself. |
| Permissions required by a supported operation | A reviewed mapping in protected tooling, where scoped credentials are supported | Keep independent expected-permission tests; do not calculate the test's expected result from the mapping being tested. |
| Deployment and recovery rules | Durable operator guidance | Update when behavior changes, not on every resource or version change. |

Prefer native installation and validation features to another wrapper where they establish the required property. Terraform validation still does not replace the pre-execution admission check. Reuse a parsed representation where practical; avoid several partial parsers with different interpretations of the same input. A restricted checker must continue to reject syntax it cannot safely inspect. Broader language support needs a deliberate parser and policy decision.

### Keep tests tied to failures

Use small synthetic fixtures with dummy credentials. Each test should say which mistake it catches and prove an observable result, such as rejection before a credential request or provider process starts. The permission-selection cases below apply to consumers that support scoped runtime credentials.

| Change under test | Useful assertion |
| --- | --- |
| An ordinary admitted value edit or new instance of an admitted type | The existing unapproved-plan path accepts it without changing trusted policy. |
| A provider upgrade | Verification and approval remain required; altered bytes, an unexpected producer, or an unapproved commit stop before execution. |
| A new unsupported expression, provider, or backend change | The protected guard rejects it or takes the explicitly configured review-required path before credentials. |
| A newly supported write operation | It receives only the independently reviewed permissions; an unsupported operation cannot request a broad fallback token. |
| A no-change plan or malformed plan | The former does not trigger provider-write elevation; the latter is rejected, not interpreted as an empty plan. |

Keep targeted integration tests for workflow ordering and real installation behavior. Avoid tests that only match incidental shell spelling, count helper files, or repeat current versions and IDs. Coverage reports can reveal missing cases, but a percentage alone does not prove the boundary. Preserve the repository's existing test contract unless changing it is an explicitly reviewed part of the work.

Before finishing a simplification, compare the allowed and rejected cases with the old implementation and explain any intentional policy change. Fewer lines or more helper files do not establish that the design is simpler. A useful result reduces the rules maintainers must understand and the files a routine edit must touch while preserving provider verification, protected executable code, credential limits, and apply approval. Credential changes and deployment remain separate operations.

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

## Recipe: constrain expressions even when they match the baseline

A protected baseline tells you what reviewers accepted previously. It does not establish that every expression in that baseline is safe for a lower-review planning path. Some expressions may intentionally read sensitive files, use credentials, or invoke features that always require review. Copying the same text into a new location can also change its effect.

For a consumer that supports ordinary data-file edits, define a small set of reviewed expression shapes and bind each exception to its original location. Admission requires both an allowed shape and equality to the trusted expression at that location. This is a consumer policy; Terraform itself does not make that distinction.

For example, suppose a reviewed root reads a local YAML file through this expression:

```hcl
locals {
  policy = yamldecode(file("${path.module}/policy.yaml"))
}
```

The example demonstrates a language form, not a blanket permission for locals or file reads. A consumer must review the YAML schema, allowed values, exact downstream attributes, and provider behavior before admitting edits. A field containing a command or destination is not harmless just because YAML represents it as a string. The [file function](https://developer.hashicorp.com/terraform/language/functions/file) reads the selected local file; the consumer supplies containment and access restrictions.

Implement the comparison as follows:

1. Parse both roots completely under the supported grammar. Preserve block labels, attribute identities, nesting, and expression meaning. Do not extract recognized fragments while ignoring surrounding syntax.
2. Identify an expression by its semantic location: root, block kind and labels, nested block path, and attribute. For a local value, include the local's name. A set of approved expression strings loses that context.
3. Permit the expression only if its structural form belongs to the consumer's reviewed subset and the corresponding baseline location contains an equivalent expression. Normalize comments/whitespace through parsing without erasing operators, escaping, or other meaningful differences.
4. Resolve referenced file paths under the admitted root. Reject traversal, unexpected symlinks, unsupported extensions, missing files, and dynamic paths. Validate data against the consumer's schema; keep path and expression changes on the review-required route.
5. Trace references through allowed locals to their consumers. Reusing an existing local in a new destination still needs its own admission decision. Do not allow arbitrary reference chains just because the first read was approved.
6. Compare removals as well as additions. A lifecycle rule or other protection that disappears needs explicit handling even though there is no replacement expression to inspect.

This pseudocode states the decision without prescribing a parser or a new production library:

```text
admit_expression(location, candidate, baseline):
    require candidate is in the supported expression class
    require baseline contains this same semantic location
    require candidate and baseline[location] are structurally equivalent
    require referenced files and downstream use satisfy protected policy
    otherwise require review or reject, as the consumer policy specifies
```

### Paired regression cases

| Change | Expected result for this example policy |
| --- | --- |
| Edit supported values in the existing YAML file | Unapproved preview remains available. |
| Change `policy.yaml` to a different file, traverse outside the root, or replace it with a symlink | Stop before Terraform reads the file. |
| Move the expression to a different resource attribute or reuse the local in an unreviewed destination | Require review; expression text alone does not grant permission. |
| Put an unsupported expression in both trusted and candidate fixtures | Still reject the unreviewed route. Equality is not enough. |
| Alter only harmless formatting | Accept if the supported parser proves the meaning and location unchanged. |
| Hide an operator after a block comment or append another declaration | Parse the whole input and reject the unsupported operation. |
| Remove a previously protected nested block | Detect the removal and apply the review policy. |

Keep these fixtures synthetic and independent of today's resource inventory. A broader language policy may justify a maintained parser; this recipe does not justify building a general interpreter from regular-expression exceptions.

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

## Recipe: adopt an existing object without taking over unrelated fields

Use this pattern when Terraform should start managing an existing object while preserving its current behavior. The threat includes adopting the wrong object, creating a duplicate, overwriting another owner's fields, or combining adoption with an unnoticed policy change. Import is a state mutation and belongs behind the normal reviewed deployment path.

Start with an ownership decision. For an invented service, the Terraform root might own its display name and timeout while another controller owns tags. Write that boundary beside the resource. Review the actual pinned provider's import and refresh implementation: required identifiers, defaults, normalization, pagination, dependent reads, and permissions all matter. A resource that sounds narrow may enumerate a much broader account during refresh.

The following HCL is a **synthetic schema illustration**. `example_service` is a fictional provider resource; do not install a provider or use a live identifier to execute it. Replace it with a reviewed resource whose schema supports the intended controls in a real consumer:

```hcl
resource "example_service" "reports" {
  name            = "reports"
  timeout_seconds = 30

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [tags]

    postcondition {
      condition     = self.name == "reports"
      error_message = "The imported service has an unexpected identity."
    }
  }
}

import {
  to = example_service.reports
  id = "service-example-001"
}
```

Here, `tags` belongs to the other controller; ignoring it is an ownership choice. The name check is only useful if that attribute meaningfully identifies the intended object in the actual provider. Prefer an immutable identity where available. A postcondition can detect a mismatch after a read or operation; it is not prior authorization and cannot undo a provider write.

### Adoption sequence

1. Verify the exact object and its import identifier with bounded, authorized reads. Confirm it is not already managed at another address or by another state. Reject duplicate imports or two addresses claiming the same object.
2. Capture the current values of fields this root will own, including intentional defaults and empty values. Review credentials, destructive effects, and partial ownership before asking for a credentialed preview.
3. Add the explicit resource and native import together. A consumer may retain the import block as durable provenance. Keep imports literal when required by the admission policy, and preserve the object identity through review.
4. Run an authorized preview. Require imports only for an adoption-only change: no creates, deletes, replacements, policy updates, or unexplained output changes. Treat discovered drift as a separate decision. Do not broaden `ignore_changes` until the plan becomes quiet.
5. After review, deploy the exact saved import plan through the protected workflow. Imports change state even when no provider write permission is needed. Preserve the normal state lock and concurrency controls.
6. Require a fresh zero-change plan before calling adoption complete. Keep the resource/import relationship reviewable, and confirm later default-branch execution sees the same configuration and state.

[Terraform's import overview](https://developer.hashicorp.com/terraform/language/import) describes the configuration-based mechanism. Ownership, bounded reads, import-only acceptance, and retained provenance are consumer policy choices.

### New resources and completed imports

An import adopts an object that already exists. A new resource should instead produce a reviewed creation plan. Do not require a matching import for every resource or invent an import ID to satisfy a checker. A consumer's import validation can require every import to target a declared resource, reject duplicate targets and object identities, and restrict identifiers to reviewed literal values without requiring imports for new or already-managed resources.

[Terraform permits removing completed import blocks](https://developer.hashicorp.com/terraform/language/import/single-resource#post-import-tasks). First verify successful adoption and a fresh zero-change plan, then remove only the import blocks in a separate change and require another zero-change plan. Keep the resource configuration; removing it can propose destruction. Retaining imports as history is also valid. Neither choice replaces state backups, ownership review, or checks on the actual saved plan.

Making imports optional does not make arbitrary configuration safe to plan or grant permission to create infrastructure. Preserve the provider, configuration, credential, and deployment controls described above. If the consumer previously required imports through a checker loaded from its protected default branch, land that policy change before submitting cleanup that the old checker rejects. Never execute candidate tooling with production credentials to bypass the old rule.

Test the distinction with synthetic configuration: a new resource without an import should pass admission, as should a mix of imported and new resources. An import targeting an undeclared resource, duplicate target, or invalid identifier should still fail. A resource without an import must still pass every other admission check. A static checker cannot establish that adoption has completed; use the intended state and the authorized plan to verify that.

### Deletion and ownership tests

Test wrong identity, duplicate targets, duplicate real-object IDs, normalized defaults, unexpected replacement, and an external change to a field deliberately owned elsewhere. Verify the ignored field is precisely the one intended; `ignore_changes = all` can hide ownership mistakes. A mocked provider can test the control flow, while real import behavior still needs an authorized preview against the intended object.

`prevent_destroy` only protects a resource while the relevant configuration remains present. Deleting the entire block also removes that protection. Enforce any staged deletion protocol through baseline comparison and saved-plan policy, including vanished resources and state-removal operations. A rule written in contributor documentation is not automatic enforcement. See the [lifecycle reference](https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle#prevent_destroy).

## Optional recipe: derive write authority from the saved plan

This pattern is useful when the provider and credential issuer support meaningfully narrower runtime permissions. It is not required for consumers that retain shared plan/apply credentials. It reduces the authority handed to the provider; it does not sandbox a job that can still obtain a broader identity.

Keep three policies separate: which configuration may be evaluated, which mutations reviewers allow, and which credentials can perform those mutations. Accepting a resource into the first policy must not automatically add it to a write profile.

1. Create the deployment's saved plan using the established planning identity. Export its JSON with the same pinned Terraform binary and protect both files as sensitive data.
2. Validate the JSON format and all fields used for decisions. Reject unsupported format versions, incomplete plans, malformed changes, and unknown action combinations. Do not translate a parsing failure or missing required evidence into “no changes.” Use Terraform's [documented JSON representation](https://developer.hashicorp.com/terraform/internals/json-format), not printed summary text.
3. Enforce the mutation policy before selecting a token. Inspect deletions, replacements, imports, state/output effects, and supported resource families. A permission profile is not approval for every action that profile can perform.
4. Map accepted provider mutations to explicitly supported permissions. For mixed change families, use a reviewed composition rule or combined profile; never take an unknown change as a reason to issue the broadest token. Where independent permission sets can safely be combined, one protected mapping and a tested composition rule can avoid a named profile for every combination. Review issuer constraints and any operation-specific restrictions before permitting composition.
5. If elevation is needed, request a short-lived credential and verify granted scope against the requested profile when the issuer exposes that information. Unexpected permissions should stop the operation.
6. Apply the same saved plan in a fresh controlled child process with the selected runtime credentials. Do not run a second plan under broader credentials or accept a candidate-selected plan path. Keep tool versions, configuration, and backend identity fixed.

An illustrative decision table uses invented change families, not provider-specific permissions:

| Accepted saved-plan content | Provider credential decision |
| --- | --- |
| No provider mutations | Keep the planning identity; do not elevate merely because the command is `.deploy`. |
| Import-only work with reviewed read behavior | No provider-write elevation when the provider supports it; state-write authority and deployment approval still apply. |
| Updates limited to service metadata | Request the explicitly defined metadata profile. |
| Updates limited to routing rules | Request the explicitly defined routing profile. |
| Mixed families | Use the reviewed composition rule or combined profile, or require separate deployments. |
| Unsupported type, action, or incomplete classification | Stop; there is no broad fallback. |

This assumes the provider obtains runtime credentials through a supported mechanism that can change between plan and apply without changing the saved configuration. Some providers capture credentials or settings from HCL/variables in the saved plan. Verify actual behavior; changing an environment variable does not necessarily override a credential embedded in that plan. Do not rewrite the saved plan to force a credential swap.

### Verify classification and its limits

Use synthetic plan JSON to cover each table row, malformed structures, unknown actions, replacements in both action orders, import metadata, and mixed-family changes. Assert rejected cases never call the issuer. Assert a no-change/import-only case never requests provider-write elevation, and an issuer returning a broader profile is rejected.

At the wrapper boundary, record the saved-plan path and digest at classification and apply, prevent untrusted mutation between them, and prove that the same artifact is used. These identity checks do not make arbitrary co-resident code safe. Test the provider's supported credential transition in an isolated fixture before relying on it during a real deployment.

Backend authorization remains separate: a provider-read identity does not make an import or state update read-only. Keep any issuer/root credential isolated from candidate code, and do not claim this profile selection is a security boundary against a compromised trusted runner.

## Credentials: describe the authority actually available

A plan can use a separate read-oriented identity where the provider and backend support it. The credential issuer must prevent that job from acquiring the write identity as well; separate secret names alone do not create a boundary. Backend reads, state locking, and provider refresh may need different permissions, so verify them rather than promising a universally read-only token.

Some consumers retain shared plan/apply credentials. In that model, skipping apply is a control-flow rule, not a reduction in credential authority. Document that limitation and rely on the reviewed admission policy without claiming the plan is a security sandbox. Changing credentials is an independent operational decision, not a hidden prerequisite for a documentation or workflow cleanup.

Read-oriented credentials still expose whatever data they can read. Keep secret-bearing files out of checkouts, artifacts, and caches; restrict access, mask logs, and remove them during cleanup. Limit inherited environment for every process. Avoid exporting credentials through general-purpose outputs or result comments.
