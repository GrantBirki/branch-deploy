// Keep the reason outside the metadata list so a code block cannot loosen the list.
export function formatLockReason(reason: unknown): string {
  const text = String(reason)
  if (/^[\w .-]+$/u.test(text)) {
    return `__Reason__: \`${text}\``
  }

  const codeBlock = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n')

  return `__Reason__:\n\n${codeBlock}`
}
