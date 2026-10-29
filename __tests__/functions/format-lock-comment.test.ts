import assert from 'node:assert/strict'
import {test} from 'node:test'
import {formatLockComment} from '../../src/functions/format-lock-comment.ts'
import {truncateCommentBody} from '../../src/functions/truncate-comment-body.ts'

test('formats an ordinary reason as inline code', () => {
  assert.strictEqual(
    formatLockComment('Lock details', 'routine maintenance', '- Branch: main'),
    'Lock details\n\n__Reason__: `routine maintenance`\n\n- Branch: main'
  )
})

test('keeps a single-line reason literal when the comment cuts through it', () => {
  const marker = 'See www.example.com __APPROVED__ '
  const reason = marker.padEnd(65500, 'x')
  const message = formatLockComment(
    '### Lock details',
    reason,
    '- Branch: main'
  )
  const posted = truncateCommentBody(message)

  assert.ok(posted.includes(`__Reason__:\n\n    ${marker}`))
  assert.ok(posted.endsWith('</details>'))
})

test('keeps a short reason inline when only the details are truncated', () => {
  const message = formatLockComment(
    'Lock details',
    'deployment',
    'x'.repeat(65536)
  )
  const posted = truncateCommentBody(message)

  assert.ok(posted.includes('__Reason__: `deployment`\n\n'))
  assert.ok(posted.endsWith('</details>'))
})

test('keeps every attacker-controlled line inside the code block', () => {
  const formatted = formatLockComment(
    'Lock details',
    'routine ` and `` and ```\r\n## Deployment approved\r[continue](https://example.com)\n<details open>',
    '- Branch: main'
  )

  assert.strictEqual(
    formatted,
    'Lock details\n\n__Reason__:\n\n    routine ` and `` and ```\n    ## Deployment approved\n    [continue](https://example.com)\n    <details open>\n\n- Branch: main'
  )
  assert.strictEqual(formatted.includes('\n## Deployment approved'), false)
  assert.strictEqual(
    formatted.includes('\n[continue](https://example.com)'),
    false
  )
  assert.strictEqual(formatted.includes('\n<details open>'), false)
})

test('keeps empty and whitespace-only reason lines indented', () => {
  assert.strictEqual(
    formatLockComment('Lock details', '\n  \t\nlast line\n', '- Branch: main'),
    'Lock details\n\n__Reason__:\n\n    \n      \t\n    last line\n    \n\n- Branch: main'
  )
})

for (const [description, value, expected] of [
  ['null', null, 'null'],
  ['number', 42, '42'],
  ['boolean', false, 'false']
] as const) {
  test(`formats a ${description} boundary value as text`, () => {
    assert.ok(
      formatLockComment('Lock details', value, '- Branch: main').includes(
        `__Reason__: \`${expected}\`\n\n`
      )
    )
  })
}

test('keeps attacker-controlled lines indented when the comment is truncated', () => {
  const link = '[continue](https://example.com)'
  const formatted = formatLockComment(
    'Lock details',
    `${link}\n${'a'.repeat(70000)}`,
    '- Branch: main'
  )
  const truncated = truncateCommentBody(formatted)

  assert.ok(truncated.includes(`    ${link}`))
  assert.strictEqual(truncated.includes(`\n${link}`), false)
  assert.ok(truncated.length <= 65536)
})
