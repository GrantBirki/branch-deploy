import {triggerCheck} from '../../src/functions/trigger-check'
import * as core from '@actions/core'

beforeEach(() => {
  jest.spyOn(core, 'setOutput').mockImplementation(() => {})
  jest.spyOn(core, 'saveState').mockImplementation(() => {})
  jest.spyOn(core, 'info').mockImplementation(() => {})
})

const setOutputMock = jest.spyOn(core, 'setOutput')
const infoMock = jest.spyOn(core, 'info')
const saveStateMock = jest.spyOn(core, 'saveState')

test('checks a message and finds a prefix trigger', async () => {
  const prefixOnly = true
  const body = '.deploy'
  const trigger = '.deploy'
  expect(await triggerCheck(prefixOnly, body, trigger)).toBe(true)
  expect(setOutputMock).toHaveBeenCalledWith('triggered', 'true')
  expect(setOutputMock).toHaveBeenCalledWith('comment_body', '.deploy')
})

test('checks a message and does not find prefix trigger', async () => {
  const prefixOnly = true
  const body = '.bad'
  const trigger = '.deploy'
  expect(await triggerCheck(prefixOnly, body, trigger)).toBe(false)
  expect(setOutputMock).toHaveBeenCalledWith('triggered', 'false')
  expect(setOutputMock).toHaveBeenCalledWith('comment_body', '.bad')
  expect(saveStateMock).toHaveBeenCalledWith('bypass', 'true')
  expect(infoMock).toHaveBeenCalledWith(
    'Trigger ".deploy" not found as comment prefix'
  )
})

test('checks a message and finds a global trigger', async () => {
  const prefixOnly = false
  const body = 'I want to .deploy'
  const trigger = '.deploy'
  expect(await triggerCheck(prefixOnly, body, trigger)).toBe(true)
  expect(setOutputMock).toHaveBeenCalledWith('triggered', 'true')
  expect(setOutputMock).toHaveBeenCalledWith(
    'comment_body',
    'I want to .deploy'
  )
})

test('checks a message and does not find global trigger', async () => {
  const prefixOnly = false
  const body = 'I want to .ping a website'
  const trigger = '.deploy'
  expect(await triggerCheck(prefixOnly, body, trigger)).toBe(false)
  expect(setOutputMock).toHaveBeenCalledWith('triggered', 'false')
  expect(setOutputMock).toHaveBeenCalledWith(
    'comment_body',
    'I want to .ping a website'
  )
  expect(saveStateMock).toHaveBeenCalledWith('bypass', 'true')
  expect(infoMock).toHaveBeenCalledWith(
    'Trigger ".deploy" not found in the comment body'
  )
})
