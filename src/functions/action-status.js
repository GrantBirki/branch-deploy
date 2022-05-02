// Default failure reaction
const thumbsDown = '-1'
// Default success reaction
const rocket = 'rocket'

// Helper function to add a status update for the action that is running a branch deployment
// It also updates the original comment with a reaction depending on the status of the deployment
export async function actionStatus(
  context,
  octokit,
  reactionId,
  message,
  success
) {
  // check if message is null or empty
  if (!message || message.length === 0) {
    const log_url = `${process.env.GITHUB_SERVER_URL}/${context.repo.owner}/${context.repo.repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    message = 'Unknown error, [check logs](' + log_url + ') for more details.'
  }

  // add a comment to the issue with the error message
  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: context.issue.number,
    body: message
  })

  // Select the reaction to add to the issue_comment
  var reaction
  if (success) {
    reaction = rocket
  } else {
    reaction = thumbsDown
  }

  // add a reaction to the issue_comment to indicate failure
  await octokit.rest.reactions.createForIssueComment({
    ...context.repo,
    comment_id: context.payload.comment.id,
    content: reaction
  })

  // remove the initial reaction on the IssueOp comment that triggered this action
  await octokit.rest.reactions.deleteForIssueComment({
    ...context.repo,
    comment_id: context.payload.comment.id,
    reaction_id: reactionId
  })
}
