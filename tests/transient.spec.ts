/** Replays the two observed stream failures and the SDK's structured status boundary without changing request policy. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { transient } from '../src/executor/dsh.ts'

const observed = ['Upstream HTTP/2 stream failed', 'Upstream response stream was interrupted']
it.each(observed)('recognizes the observed PI_AI_ERROR failure: %s', message => {
  expect(transient(new LlmError(message, 'PI_AI_ERROR'))).toBe(true)
  expect(transient(new LlmError(message, 'INVALID_REQUEST'))).toBe(false)
  expect(transient(new Error(message))).toBe(false)
})
it.each([408, 429, 500, 502, 503, 599])('reads SDK failure.status %i without requiring error.status', status => {
  const error = new LlmError('Provider response failed', 'SERVER', { status })
  expect('status' in error).toBe(false)
  expect(transient(error)).toBe(true)
})
it.each([400, 401, 403, 404, 413, 422])('does not retry explicit SDK refusal %i even with passing-looking text', status => {
  expect(transient(new LlmError('fetch failed with an upstream 502', 'PI_AI_ERROR', { status }))).toBe(false)
})
it('keeps legacy status support while explicit cancellation and refusal win', () => {
  expect(transient(Object.assign(new Error('Unavailable'), { status: 502 }))).toBe(true)
  expect(transient(Object.assign(new LlmError(observed[0]!, 'PI_AI_ERROR', { status: 503 }), { name: 'AbortError' }))).toBe(false)
  expect(transient(new LlmError('fetch failed', 'ABORTED', { status: 503 }))).toBe(false)
  expect(transient(new LlmError('network error', 'AUTH'))).toBe(false)
  expect(transient(Object.assign(new LlmError('Unavailable', 'SERVER', { status: 503 }), { status: 401 }))).toBe(false)
})
it.each(['Concurrency limit exceeded; please retry', 'Unknown provider error', 'Upstream response stream was interrupted while decoding arbitrary output'])('does not generalize PI_AI_ERROR: %s', message => {
  expect(transient(new LlmError(message, 'PI_AI_ERROR'))).toBe(false)
})
