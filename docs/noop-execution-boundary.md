# Noop Execution Boundary

## TLDR

- Branch Deploy's `.noop` command selects consumer-defined steps. It does not sandbox or restrict them.
- Terraform `init`, `validate`, and `plan` can load candidate-controlled configuration, modules, backends, credential helpers, and provider executables. A plan can read credentials and make network requests even when it does not apply changes.
- Inspect the exact admitted SHA with protected, non-executing policy checks before candidate tooling, provider installation or loading, backend initialization, or deployment credential access.

## What Branch Deploy guarantees

When Branch Deploy accepts a `.noop` request, it sets the `noop` output to the string `true` and lets the consumer workflow choose its next steps. Branch Deploy performs its configured IssueOps, permission, CI, target, fork, and lock checks, but it does not inspect or constrain the commands in those steps.

For non-fork pull requests, noop mode does not require PR approval by default. Passing CI and the other configured Action checks shows that the request met those gates. It does not prove that candidate Terraform or another build tool is safe to execute with the job's authority. Fork deployments remain subject to the Action's separate fork restrictions and review requirements.

A safe noop is therefore a property of the consumer workflow. The name does not guarantee that infrastructure, state, repository content, files, credentials, or remote services remain unchanged.

## Put checks before execution and authority

Use a separate validation job with read-only repository permission. Check out the exact `sha` output and inspect it with tooling from a protected revision. Give this job no deployment environment, cloud credentials, provider credentials, cache restore, or artifact input from candidate-controlled jobs. Do not run candidate package scripts, hooks, binaries, Terraform commands, or other executable helpers while deciding whether the candidate is allowed to run.

The protected check should cover every input that can change execution, including provider and module sources, dependency versions and lockfiles, backend and workspace selection, CLI configuration, automatic variable files, data sources, file reads, symlinks, local executables, and environment-driven overrides. Unsupported syntax or incomplete input must fail closed or require review. Never fall back to unrestricted evaluation.

Only after that check succeeds should a later job expose a deployment environment or credentials and run the exact same admitted SHA. Keep orchestration and policy code on the trusted revision. If the policy requires approval for provider, backend, module, or tool changes, verify that the current eligible approval covers the exact candidate SHA before any of those components execute.

## Terraform commands are not admission checks

`terraform init -backend=false` avoids initializing the configured backend, but it can still install modules and providers selected by candidate configuration. `terraform validate` can start provider processes to validate schemas. `terraform plan` can refresh state, invoke providers and data sources, read local files, use credentials, and contact remote services.

These commands are useful after admission. They do not replace a protected pre-execution policy, and their success does not prove that the candidate stayed inside the intended trust boundary.

For detailed Terraform policy design, provider verification, exact-commit review checks, and isolated negative tests, see [Terraform plans and provider integrity](security_hardening_guides/terraform-plans.md). For checkout separation and immutable candidate selection, see [Trusted Checkouts](trusted-checkouts.md). For reporting work from later jobs, see [Result Mode](result-mode.md).

## Failure behavior

If the protected check cannot classify a candidate, stop before candidate execution or credential access. Report the rule that failed or the review that is required. Do not reinterpret that failure as an empty or successful plan. After the candidate or approval changes, rerun the full workflow so Branch Deploy repeats its admission checks.
