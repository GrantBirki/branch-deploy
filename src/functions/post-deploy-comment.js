import * as core from '@actions/core'
import {actionStatus} from './action-status'

// Helper function to help facilitate the process of completing a deployment
// :param context: The GitHub Actions event context
// :param octokit: The octokit client
// :param post_deploy: A boolean that is used to check if this function should run
// :param deployment_comment_id: The comment_id which initially triggered the deployment Action
// :param deployment_status: The status of the deployment (String)
// :param deployment_message: A custom string to add as the deployment status message (String)
// :param deployment_result_ref: The ref (branch) which is being used for deployment (String)
// :param deployment_mode_noop: Indicates whether the deployment is a noop or not (String)
// :returns: true if the function completed successfully, false if the context is not a post deploy workflow, error if anything goes wrong
export async function postDeployComment(
  context,
  octokit,
  post_deploy,
  dataRaw,
  deployment_comment_id,
  deployment_status,
  deployment_message,
  deployment_result_ref,
  deployment_mode_noop
) {
  // Check if this action is requesting the post_deploy workflow
  if (post_deploy === 'true' || post_deploy === true) {
    core.info('post_deploy logic triggered... executing')
  } else {
    // Exit out of this function if this action is not requesting the post_deploy workflow
    return false
  }

  // If the stage one deployment result object was provided, use that instead of individual variables
  if (dataRaw) {
    const data = JSON.parse(dataRaw)
    deployment_mode_noop = data.noop
    deployment_comment_id = data.comment_id
    deployment_result_ref = data.ref
  }

  // Check the inputs to ensure they are valid
  if (
    deployment_comment_id &&
    deployment_status &&
    deployment_message &&
    deployment_result_ref &&
    deployment_mode_noop
  ) {
    core.debug('post_deploy inputs passed initial check')
  } else if (!deployment_comment_id || deployment_comment_id.length === 0) {
    throw new Error('no deployment_comment_id provided')
  } else if (!deployment_status || deployment_status.length === 0) {
    throw new Error('no deployment_status provided')
  } else if (!deployment_message || deployment_message.length === 0) {
    throw new Error('no deployment_message provided')
  } else if (!deployment_result_ref || deployment_result_ref.length === 0) {
    throw new Error('no deployment_result_ref provided')
  } else {
    throw new Error(
      'An unhandled condition was encountered while processing post-deployment logic'
    )
  }

  // Check the deployment status
  var success
  if (deployment_status === 'success') {
    success = true
  } else {
    success = false
  }

  var banner
  var deployTypeString = ' ' // a single space as a default

  // Set the message banner and deploy type based on the deployment mode
  if (deployment_mode_noop === 'true') {
    banner = 'noop 🧪'
    deployTypeString = ' noop '
  } else {
    banner = 'production 🪐'
  }

  // Dynamically set the message text depending if the deployment succeeded or failed
  var message
  var deployStatus
  if (deployment_status === 'success') {
    message = `Successfully${deployTypeString}deployed branch **${deployment_result_ref}**`
    deployStatus = `\`${deployment_status}\` ✔️`
  } else if (deployment_status === 'failure') {
    message = `Failure when${deployTypeString}deploying branch **${deployment_result_ref}**`
    deployStatus = `\`${deployment_status}\` ❌`
  } else {
    message = `Warning:${deployTypeString}deployment status is unknown, please use caution`
    deployStatus = `\`${deployment_status}\` ⚠️`
  }

  // Format the message body
  const deployment_message_fmt = `
  ### Deployment Results - ${banner}

  - Deployment${' ' + deployTypeString.trim()}: ${deployStatus}
  - Branch: \`${deployment_result_ref}\`

  <details><summary>Show Results</summary>

  \`\`\`${deployment_message}\`\`\`

  </details>

  ${message}

  > Pusher: @${context.actor}, Action: \`${context.eventName}\`, Workflow: \`${
    context.workflow
  }\`
  `

  // Update the action status to indicate the result of the deployment as a comment
  await actionStatus(
    context,
    octokit,
    parseInt(deployment_comment_id),
    deployment_message_fmt,
    success
  )

  // If the post deploy comment logic completes successfully, return true
  return true
}
