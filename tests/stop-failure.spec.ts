/** Stop classification trusts the runtime's explicit release guarantee, never nested messages or causes. */
import { expect, it } from 'vitest'
import { combineStopFailures, stopFailureParts } from '../src/executor/stop-failure.ts'

const resultFailure = () => Object.assign(new Error('Provider result unavailable after release'), { code: 'ACTIVATION_RESULT_FAILED' })

it('preserves the sole runtime-confirmed result failure and its code', () => {
  const error = resultFailure()
  expect(combineStopFailures([error], 'stop failed')).toBe(error)
  expect(stopFailureParts(error)).toEqual({ cleanup: [], results: [error] })
})

it('retains both result diagnostics and independent cleanup failures across owned aggregates', () => {
  const result = resultFailure(), cleanup = new Error('job kill failed')
  const mixed = combineStopFailures([cleanup, result], 'stop failed')
  expect(mixed).toBeInstanceOf(AggregateError)
  expect(stopFailureParts(combineStopFailures([mixed, result], 'stops failed')))
    .toEqual({ cleanup: [cleanup], results: [result, result] })
})

it('does not infer resource release from a message, nested result code, or teardown error cause', () => {
  const result = resultFailure()
  for (const error of [new Error('ACTIVATION_RESULT_FAILED'), new AggregateError([result], 'unknown cleanup'),
    Object.assign(new Error('unconfirmed resource', { cause: result }), { code: 'ACTIVATION_TEARDOWN_FAILED' })]) {
    expect(stopFailureParts(error)).toEqual({ cleanup: [error], results: [] })
  }
})
