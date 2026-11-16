import { expect, it } from 'vitest'
import { HealthBoard } from '../src/infra/health.ts'
import { WorkerHealth, workerError } from '../src/executor/worker-health.ts'

it('retains nested cleanup reasons and redacts secrets within a bounded detail', () => {
  const detail = workerError(new AggregateError([
    new TypeError('stopDescendants is not a function'),
    new Error('Authorization: Bearer abc token=xyz password=secret https://user:pass@host/path'),
  ], 'Stopping worker-a failed'))
  expect(detail).toContain('TypeError: stopDescendants is not a function')
  expect(detail).not.toMatch(/\babc\b|\bxyz\b|password=secret|user:pass/)
  expect(workerError(new Error('x'.repeat(10000))).length).toBeLessThanOrEqual(2000)
})

it('recovers only the same cleanup and does not hide other tickets failures', async () => {
  const board = new HealthBoard(), health = board.claim('worker'), worker = new WorkerHealth(health)
  await worker.watch(Promise.reject(new Error('tree-a failed')), 'cleanup:a')
  await worker.watch(Promise.resolve())
  expect(health.get()).toMatchObject({ state: 'error', detail: expect.stringContaining('tree-a failed') })
  await worker.watch(Promise.reject(new Error('tree-b failed')), 'cleanup:b')
  await worker.watch(Promise.resolve(), 'cleanup:a')
  expect(health.get()).toMatchObject({ state: 'error', detail: expect.stringContaining('tree-b failed') })
  expect(health.get()?.detail).not.toContain('tree-a failed')
  await worker.watch(Promise.resolve(), 'cleanup:b')
  expect(health.get()?.state).toBe('ready')
})

it('recovers only the synchronously reverified idle operation and ignores its older attempt', async () => {
  const health = new HealthBoard().claim('worker'), worker = new WorkerHealth(health)
  await worker.watch(Promise.reject(new Error('idle failed')), 'idle:a')
  await worker.watch(Promise.reject(new Error('cleanup unknown')), 'cleanup:b')
  const old = Promise.withResolvers<void>()
  const watched = worker.watch(old.promise, 'idle:a')
  worker.recover('idle:a')
  old.reject(new Error('obsolete observation')); await watched
  expect(health.get()?.detail).toContain('cleanup unknown')
  expect(health.get()?.detail).not.toContain('idle failed')
  expect(health.get()?.detail).not.toContain('obsolete observation')
})

it('does not let an older successful attempt overwrite a newer failure', async () => {
  const health = new HealthBoard().claim('worker'), worker = new WorkerHealth(health)
  const older = Promise.withResolvers<void>()
  const pending = worker.watch(older.promise, 'cleanup:a')
  await worker.watch(Promise.reject(new Error('new failure')), 'cleanup:a')
  older.resolve(); await pending
  expect(health.get()).toMatchObject({ state: 'error', detail: expect.stringContaining('new failure') })
})
