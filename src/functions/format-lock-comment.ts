import {retainedCommentLength} from './truncate-comment-body.ts'

export function formatLockComment(
  header: string,
  reason: unknown,
  details: string
): string {
  const text = String(reason)
  const prefix = `${header}\n\n__Reason__:`
  const suffix = `\n\n${details}`
  if (/^[\w .-]+$/u.test(text)) {
    const inline = `${prefix} \`${text}\``
    // A cut before the closing backtick exposes the reason as Markdown.
    if (inline.length <= retainedCommentLength(inline.length + suffix.length)) {
      return inline + suffix
    }
  }

  const codeBlock = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n')

  return `${prefix}\n\n${codeBlock}${suffix}`
}
