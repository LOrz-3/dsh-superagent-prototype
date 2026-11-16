/** Local process termination cannot prove that a partial remote diagnostic is a completed API response. */
import { describe, expect, it } from 'vitest'
import { CliError, commandError } from '../src/infra/commands.ts'

const terminations = [
  ['timeout', { killed: true, signal: 'SIGTERM', code: null }, 'timed out after 90 s'],
  ['output limit', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' }, 'printed more output than it may'],
  ['signal', { killed: false, signal: 'SIGKILL', code: null }, 'was stopped by SIGKILL'],
  ['killed without signal', { killed: true, signal: null, code: 1 }, 'was terminated'],
] as const
const diagnostics = [
  'Get "https://api.github.com/repos/example/repo/issues/321": EOF',
  'gh: Gone (HTTP 410)',
  'gh: Not Found (HTTP 404)',
  '{"error":{"code":230011,"message":"fixture recalled state"}}',
  '{"error":{"code":232011,"message":"fixture membership state"}}',
]
describe.each(terminations)('command termination diagnostics: %s', (_name, facts, reason) => {
  it.each(['gh: HTTP 304', 'gh: HTTP 410', 'attempt 7'])('retains a non-JSON diagnostic ending in a digit: %s', stderr => {
    const result = commandError({ ...facts, stderr }, 'gh')
    expect(result.message).toBe(`gh ${reason}; stderr: ${stderr}`)
    expect(result).toMatchObject({ code: undefined })
  })
  it.each(diagnostics)('keeps local facts before stderr: %s', stderr => {
    const result = commandError({ ...facts, stderr }, 'gh')
    expect(result).toBeInstanceOf(CliError)
    expect(result.message).toContain(`gh ${reason}`)
    const diagnostic = stderr.startsWith('{') ? JSON.parse(stderr).error.message : stderr
    expect(result.message).toContain(diagnostic)
    expect(result).toMatchObject({ code: undefined })
    expect((result as CliError).exitCode).toBe(typeof facts.code === 'number' ? facts.code : undefined)
  })
})
it.each(terminations)('retains only JSON error.message after %s', (_name, facts, reason) => {
  const payload = JSON.stringify({ error: { code: 410, message: 'fixture remote message' }, request: { body: 'PRIVATE_BODY', argv: ['PRIVATE_ARGV'] } })
  for (const stderr of [payload, `[page 1] fetching...\n${payload}`]) {
    const result = commandError({ ...facts, stderr }, 'gh')
    expect(result.message).toContain(`gh ${reason}; stderr: fixture remote message`)
    expect(result.message).not.toContain('PRIVATE_BODY')
    expect(result.message).not.toContain('PRIVATE_ARGV')
    expect(result).toMatchObject({ code: undefined })
  }
})
it.each(terminations)('does not echo JSON without an error.message after %s', (_name, facts, reason) => {
  for (const value of [{ request: { body: 'PRIVATE_BODY', argv: ['PRIVATE_ARGV'] } },
    [{ error: { message: 'PRIVATE_BODY' } }], 'PRIVATE_ARGV']) {
    const result = commandError({ ...facts, stderr: JSON.stringify(value) }, 'gh')
    expect(result.message).toBe(`gh ${reason}`)
    expect(result).toMatchObject({ code: undefined })
  }
})
it('retains the same message-only JSON diagnostic on a completed ordinary API failure', () => {
  const stderr = JSON.stringify({ error: { code: 410, message: 'fixture remote message' }, request: { body: 'PRIVATE_BODY', argv: ['PRIVATE_ARGV'] } })
  const result = commandError({ code: 1, stderr }, 'gh')
  expect(result).toMatchObject({ message: 'fixture remote message (410)', code: 410, exitCode: 1 })
  expect(result.message).not.toContain('PRIVATE_')
})
it('keeps a valid prefixed JSON diagnostic and its normal completed API state', () => {
  const stderr = 'attempt 7\n' + JSON.stringify({ error: { code: 232011, message: 'fixture API state' }, request: { body: 'PRIVATE_BODY', argv: ['PRIVATE_ARGV'] } })
  const result = commandError({ code: 1, stderr }, 'lark')
  expect(result).toMatchObject({ message: 'fixture API state (232011)', code: 232011, exitCode: 1 })
  expect(result.message).not.toContain('PRIVATE_')
})
it('keeps AbortError identity ahead of all diagnostics and local termination facts', () => {
  const aborted = Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError', killed: true, signal: 'SIGTERM', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: 'gh: Gone (HTTP 410)',
  })
  expect(commandError(aborted, 'gh')).toBe(aborted)
})
it.each([304, 404, 410, 500])('keeps HTTP %i from an ordinary completed nonzero CLI exit', code => {
  expect(commandError({ code: 1, killed: false, signal: null, stderr: `gh: HTTP ${code}` }, 'gh'))
    .toMatchObject({ code, exitCode: 1, message: `gh: HTTP ${code}` })
})
it.each([230011, 232011, 999])('keeps ordinary completed Feishu API state %i', code => {
  expect(commandError({ code: 1, stderr: JSON.stringify({ error: { code, message: 'fixture API state' } }) }, 'lark'))
    .toMatchObject({ code, exitCode: 1, message: `fixture API state (${code})` })
})
it('bounds retained stderr and never uses an argv-bearing generic error message', () => {
  const result = commandError({ killed: true, signal: 'SIGTERM', stderr: 'EOF '.repeat(10000),
    message: 'Command failed: gh private command arguments' }, 'gh')
  expect(result.message).toContain('timed out after 90 s; stderr: EOF')
  expect(result.message.length).toBeLessThan(2100)
  expect(result.message).not.toContain('private command arguments')
})
