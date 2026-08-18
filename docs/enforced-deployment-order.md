# 🚦 Enforced Deployment Order

## What is Enforced Deployment Order?

Enforced Deployment Order is a feature that allows you to specify a strict sequence in which deployments must occur across different environments. By defining an enforced deployment order, you ensure that deployments to subsequent environments only happen after successful deployments to preceding environments. This helps maintain the integrity and stability of your deployment pipeline by preventing out-of-order deployments that could introduce issues or inconsistencies.

This feature is entirely optional and can be enabled easily should your project or team require it.

If you do not set/enable this feature, deployments will proceed without any enforced order (the default behavior).

## How Does Enforced Deployment Order Work?

When you enable enforced deployment order, you define a specific sequence of environments in which deployments must occur. This sequence is set with the `enforced_deployment_order` input option.

Let's assume you have three environments: `development`, `staging`, and `production`. If you set the `enforced_deployment_order` input to `development,staging,production`, then deployments must occur in the following order: `development` -> `staging` -> `production`. If you were to attempt a `.deploy to production` command without having first deployed to `development` and `staging`, the deployment would fail and tell you why.

The branch-deploy Action determines which environments have been successfully deployed by using GitHub's GraphQL API to query each environment's deployment history. The `deployment_order_scope` input controls which history is authoritative.

Here is how that process takes place under the hood:

1. With the default `deployment_order_scope: all`, a request to the GraphQL API fetches the newest deployment for each preceding environment, ordered by its `CREATED_AT` timestamp.
2. With `deployment_order_scope: branch-deploy`, the Action searches newest-to-oldest and selects the first deployment whose payload identifies it with `type: branch-deploy`. Deployments with a null payload or a valid different type are ignored. Malformed deployment history fails closed.
3. The selected deployment must be `ACTIVE` and its `deployment.commit.oid` must exactly match the commit SHA requested for deployment. A newer failed, pending, inactive, or different-SHA deployment within the selected scope is authoritative; an older active deployment cannot satisfy the order.

The `branch-deploy` scope is useful when another Actions job creates incidental deployment records for the same environment. It also ignores real deployments made by other systems, so enable it only when Branch Deploy is authoritative for promotion through these environments. The payload type is a marker, not proof of who created the deployment; any integration with permission to create deployments can set it.

The configured order must not contain duplicate environments, and every requested environment must appear in the order. Branch Deploy rejects invalid order configuration instead of silently skipping or repeating checks.

It should be noted that if a "rollback" style deployment is used (ex: `.deploy main to <environment>`), then all "enforced deployment order" checks are skipped so that a rollback deployment can be performed to any environment at any time.

## Why Use Enforced Deployment Order?

Using enforced deployment order can help maintain the integrity and stability of your deployment pipeline. By ensuring that deployments occur in a specific sequence, you can:

- Prevent issues that may arise from deploying to production before testing in staging.
- Ensure that each environment is properly validated before moving to the next.
- Maintain a clear and predictable deployment process.

## How to Configure

To enable enforced deployment order, set the `enforced_deployment_order` input in your workflow file. The value for `enforced_deployment_order` is a comma-separated string that specifies the order of environments from left to right. Here is an example configuration:

```yaml
- uses: github/branch-deploy@vX.X.X
  id: branch-deploy
  with:
    environment_targets: development,staging,production # <-- these are the defined environments that are available for deployment
    enforced_deployment_order: development,staging,production # <-- here is where the enforced deployment order is set - it is read from left to right
```

To ignore unrelated deployment records during order checks, opt in to the Branch Deploy scope:

```yaml
- uses: github/branch-deploy@vX.X.X
  id: branch-deploy
  with:
    environment_targets: development,staging,production
    enforced_deployment_order: development,staging,production
    deployment_order_scope: branch-deploy
```

If another job uses an environment only for secrets or variables, prefer preventing that job from creating an incidental deployment:

```yaml
environment:
  name: development
  deployment: false
```

The `deployment: false` setting is incompatible with [custom deployment protection rules](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments#using-custom-deployment-protection-rules). If the job needs those rules, keep deployment creation enabled or use a separate environment. These workflow changes preserve the default `all` scope, where every deployment system can update the authoritative environment state.

## Closing Notes

Using enforced deployment order is entirely optional and may not be necessary for all projects or teams. However, if you find that your deployment pipeline would benefit from a strict sequence of deployments, this feature can help you maintain the integrity and stability of your deployments. It should be noted that requiring a strict deployment order may introduce some overhead, complexity, and friction to your deployment process, so it is important to weigh the benefits against the costs and determine if this feature is right for your project or team.
