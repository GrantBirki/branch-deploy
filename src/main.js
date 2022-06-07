import * as core from '@actions/core'
import {triggerCheck} from './functions/trigger-check'
import {contextCheck} from './functions/context-check'
import {reactEmote} from './functions/react-emote'
import {actionStatus} from './functions/action-status'
import {createDeploymentStatus} from './functions/deployment'
import {prechecks} from './functions/prechecks'
import {post} from './functions/post'
import * as github from '@actions/github'
import {context} from '@actions/github'
import dedent from 'dedent-js'

// :returns: 'success', 'success - noop', 'failure', 'safe-exit', or raises an error
export async function run() {
  try {
    // Get the inputs for the branch-deploy Action
    const trigger = core.getInput('trigger')
    const reaction = core.getInput('reaction')
    const prefixOnly = core.getInput('prefix_only') === 'true'
    const token = core.getInput('github_token', {required: true})
    const environment = core.getInput('environment', {required: true})
    const stable_branch = core.getInput('stable_branch')
    const noop_trigger = core.getInput('noop_trigger')
    const noop_strict_update = core.getInput('noop_strict_update') === 'true'
    const required_contexts = core.getInput('required_contexts')

    // Set the state so that the post run logic will trigger
    core.saveState('isPost', 'true')
    core.saveState('actionsToken', token)
    core.saveState('environment', environment)

    // Check the context of the event to ensure it is valid, return if it is not
    if (!(await contextCheck(context))) {
      return 'safe-exit'
    }

    // Get variables from the event context
    const body = context.payload.comment.body.trim()
    const issue_number = context.payload.issue.number
    const {owner, repo} = context.repo

    // Create an octokit client
    const octokit = github.getOctokit(token)

    // Check if the comment body contains the trigger, exit if it doesn't return true
    if (!(await triggerCheck(prefixOnly, body, trigger))) {
      return 'safe-exit'
    }

    // Add the reaction to the issue_comment as we begin to start the deployment
    const reactRes = await reactEmote(reaction, context, octokit)
    core.setOutput('comment_id', reactRes.data.id)
    core.saveState('comment_id', reactRes.data.id)

    // Execute prechecks to ensure the deployment can proceed
    const precheckResults = await prechecks(
      body,
      trigger,
      noop_trigger,
      noop_strict_update,
      stable_branch,
      issue_number,
      context,
      octokit
    )
    core.setOutput('ref', precheckResults.ref)
    core.saveState('ref', precheckResults.ref)

    // If the prechecks failed, run the actionFailed function and return
    if (!precheckResults.status) {
      await actionStatus(
        context,
        octokit,
        reactRes.data.id,
        precheckResults.message
      )
      // Set the bypass state to true so that the post run logic will not run
      core.saveState('bypass', 'true')
      core.setFailed(precheckResults.message)
      return 'failure'
    }

    // Set outputs for noopMode
    var noop
    if (precheckResults.noopMode) {
      noop = 'true'
      core.setOutput('noop', noop)
      core.setOutput('continue', 'true')
      core.saveState('noop', noop)
      core.info('noop mode detected')
      // If noop mode is enabled, return
      return 'success - noop'
    } else {
      noop = 'false'
      core.setOutput('noop', noop)
      core.saveState('noop', noop)
    }

    // Get required_contexts for the deployment
    var requiredContexts = []
    if (
      required_contexts &&
      required_contexts !== '' &&
      required_contexts !== 'false'
    ) {
      requiredContexts = required_contexts.split(',').map(function (item) {
        return item.trim()
      })
    }

    // Create a new deployment
    const {data: createDeploy} = await octokit.rest.repos.createDeployment({
      owner: owner,
      repo: repo,
      ref: precheckResults.ref,
      required_contexts: requiredContexts
    })
    core.saveState('deployment_id', createDeploy.id)

    // If a merge to the base branch is required, let the user know and exit
    if (
      typeof createDeploy.id === 'undefined' &&
      createDeploy.message.includes('Auto-merged')
    ) {
      const mergeMessage = dedent(`
        ### ⚠️ Deployment Warning

        Message: ${createDeploy.message}

        > Deployment will not continue. Please try again once this branch is up-to-date with the base branch
        `)
      await actionStatus(context, octokit, reactRes.data.id, mergeMessage)
      core.warning(mergeMessage)
      // Enable bypass for the post deploy step since the deployment is not complete
      core.saveState('bypass', 'true')
      return 'safe-exit'
    }

    // Set the deployment status to in_progress
    await createDeploymentStatus(
      octokit,
      context,
      precheckResults.ref,
      'in_progress',
      createDeploy.id,
      environment
    )

    core.setOutput('continue', 'true')

    return 'success'
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

/* istanbul ignore next */
if (core.getState('isPost') === 'true') {
  post()
} else {
  if (process.env.CI === 'true') {
    run()
  }
}
