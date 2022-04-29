import * as core from '@actions/core'
import {triggerCheck} from './functions/trigger-check'
import {contextCheck} from './functions/context-check'
import {reactEmote} from './functions/react-emote'
import * as github from '@actions/github'
import {context} from '@actions/github'

async function run() {
  try {
    // Get the inputs for the branch-deploy Action
    const trigger = core.getInput('trigger')
    const reaction = core.getInput('reaction')
    const prefixOnly = core.getInput('prefix_only') === 'true'
    const token = core.getInput('github_token', {required: true})
    const environment = core.getInput('environment', {required: true})
    const stable_branch = core.getInput('stable_branch')
    const noop_trigger = core.getInput('noop_trigger')
    const body = context.payload.comment.body

    // Check the context of the event to ensure it is valid, return if it is not
    if (!(await contextCheck(context))) {
      return
    }

    // Check if the comment body contains the trigger, exit if it doesn't return true
    if (!(await triggerCheck(prefixOnly, body, trigger))) {
      return
    }

    // Create an octokit client
    const octokit = github.getOctokit(token)

    // Add the reaction to the issue_comment
    await reactEmote(reaction, context, octokit)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()

// core.info(`context: ${JSON.stringify(context)}`)
