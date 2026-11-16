/** Runtime shutdown keeps its database and lock until work is confirmed idle and cleanup is complete. */
import { basename, resolve } from 'node:path'
import { rmSync } from 'node:fs'
import { checkSync } from 'proper-lockfile'
import { expect, it, onTestFinished, vi } from 'vitest'
import { workerError } from '../src/executor/worker-health.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

async function setup() {
  const h = await startRuntime()
  const executorDispose = h.runtime.executor.dispose.bind(h.runtime.executor)
  const sessionsDispose = h.runtime.sessions.dispose.bind(h.runtime.sessions)
  let expectedFinalizerFailure = false
  onTestFinished(async () => {
    try {
      await h.runtime.stop()
    } catch (error: unknown) {
      if (!expectedFinalizerFailure) throw error
      // The fixture owns synthetic failing finalizers; explicitly release its raw resources after assertions.
      vi.restoreAllMocks()
      executorDispose()
      await sessionsDispose()
      if (h.runtime.store.db.isOpen) h.runtime.store.close()
      await h.runtime['releaseLock']?.()
    } finally {
      vi.restoreAllMocks()
      expect(resolve(h.directory)).toBe(h.directory)
      expect(basename(h.directory)).toMatch(/^orchestrator-host-/)
      rmSync(h.directory, { recursive: true, force: true })
    }
  })
  return { ...h, expectFinalizerFailure: () => { expectedFinalizerFailure = true } }
}

it('shares an in-flight stop, retains Store and lock after unknown cleanup, and performs a fresh confirmed retry', async () => {
  const h = await setup()
  await h.acceptedTicket(feishu('1', '@bot stop safely'))
  const cleanup = new Error('worker cleanup remains unconfirmed')
  const shutdown = vi.spyOn(h.runtime.executor, 'shutdown').mockRejectedValueOnce(cleanup)
  const sessions = vi.spyOn(h.runtime.sessions, 'dispose'), flush = vi.spyOn(h.ctx.sessionPersistence, 'flush')
  const beforeFlush = flush.mock.calls.length
  let reentrant: Promise<void> | undefined
  const stopAssessor = h.runtime.assessor.stop.bind(h.runtime.assessor)
  vi.spyOn(h.runtime.assessor, 'stop').mockImplementationOnce(() => { reentrant = h.runtime.stop(); stopAssessor() })
  const first = h.runtime.stop()
  expect(reentrant).toBe(first)
  expect(h.runtime.stop()).toBe(first)
  await expect(first).rejects.toMatchObject({ errors: [cleanup] })
  expect(h.runtime.store.db.isOpen).toBe(true)
  expect(checkSync(h.directory)).toBe(true)
  expect(sessions).not.toHaveBeenCalled()
  expect(flush).toHaveBeenCalledTimes(beforeFlush)
  expect(() => h.runtime.receive(feishu('2', '@bot no new work'))).toThrow('stopping')
  const retry = h.runtime.stop()
  expect(retry).not.toBe(first)
  await retry
  expect(shutdown).toHaveBeenCalledTimes(2)
  expect(sessions).toHaveBeenCalledWith(true)
  expect(h.runtime.store.db.isOpen).toBe(false)
  expect(checkSync(h.directory)).toBe(false)
})

it('attempts every cancellation, idle observation, and executor cleanup after independent failures', async () => {
  const h = await setup()
  const one = await h.acceptedTicket(feishu('1', '@bot one'))
  const two = await h.acceptedTicket(feishu('5', '@bot two'))
  const first = h.agents.get(one.sessionId)!, second = h.agents.get(two.sessionId)!
  const cancel = first.cancel.getMockImplementation()!
  first.cancel.mockImplementationOnce((...args: unknown[]) => {
    cancel(...args as [unknown, { keepInbox?: boolean }]); throw new Error('cancel queue write failed')
  })
  const idle = vi.spyOn(first, 'whenIdle').mockRejectedValueOnce(new Error('idle observation failed'))
  const shutdown = vi.spyOn(h.runtime.executor, 'shutdown')
  const failure: unknown = await h.runtime.stop().catch(error => error)
  expect(workerError(failure)).toContain('cancel queue write failed')
  expect(workerError(failure)).toContain('idle observation failed')
  expect(second.cancel).toHaveBeenCalled()
  expect(shutdown).toHaveBeenCalled()
  expect(h.runtime.store.db.isOpen).toBe(true)
  expect(checkSync(h.directory)).toBe(true)
  idle.mockRestore()
  await h.runtime.stop()
})

it('observes the same successful finalization receipt after timeout without replaying its disposer', async () => {
  const h = await setup()
  await h.acceptedTicket(feishu('1', '@bot finalizer receipt'))
  const receipt = Promise.withResolvers<void>()
  const original = h.runtime.sessions.dispose.bind(h.runtime.sessions)
  const dispose = vi.spyOn(h.runtime.sessions, 'dispose').mockImplementationOnce(async keepGuards => {
    await receipt.promise
    await original(keepGuards)
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const first = expect(h.runtime.stop()).rejects.toThrow('shutdown failed')
    await vi.advanceTimersByTimeAsync(10_000)
    await first
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(h.runtime.store.db.isOpen).toBe(true)
    expect(checkSync(h.directory)).toBe(true)
    receipt.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runtime.store.db.isOpen).toBe(true)
    expect(checkSync(h.directory)).toBe(true)
    await h.runtime.stop()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(h.runtime.store.db.isOpen).toBe(false)
    expect(checkSync(h.directory)).toBe(false)
  } finally { receipt.resolve(); vi.useRealTimers() }
})

it('attempts independent finalizers and flush, retaining their errors without treating a memoized disposer as recovery', async () => {
  const h = await setup()
  h.expectFinalizerFailure()
  await h.acceptedTicket(feishu('1', '@bot finalize'))
  const executor = vi.spyOn(h.runtime.executor, 'dispose').mockImplementationOnce(() => { throw new Error('executor unbind failed') })
  const sessions = vi.spyOn(h.runtime.sessions, 'dispose')
  const restore = vi.spyOn(h.runtime.setup, 'restore')
  const other = vi.fn()
  h.runtime['disposers'].push(other, () => { throw new Error('route unbind failed') })
  vi.spyOn(h.ctx.sessionPersistence, 'flush').mockRejectedValueOnce(new Error('session flush failed'))
  const failure: unknown = await h.runtime.stop().catch(error => error)
  expect(workerError(failure)).toContain('executor unbind failed')
  expect(workerError(failure)).toContain('route unbind failed')
  expect(workerError(failure)).toContain('session flush failed')
  expect(sessions).toHaveBeenCalledWith(true)
  expect(restore).toHaveBeenCalled()
  expect(other).toHaveBeenCalledTimes(1)
  expect(h.runtime.store.db.isOpen).toBe(true)
  expect(checkSync(h.directory)).toBe(true)
  await expect(h.runtime.stop()).rejects.toThrow('shutdown failed')
  expect(executor).toHaveBeenCalledTimes(1)
  expect(other).toHaveBeenCalledTimes(1)
  expect(h.runtime.store.db.isOpen).toBe(true)
})

it('retains guards and the directory lock when Store.close fails, then closes it before releasing either', async () => {
  const h = await setup()
  const one = await h.acceptedTicket(feishu('1', '@bot close safely'))
  const close = vi.spyOn(h.runtime.store, 'close').mockImplementationOnce(() => { throw new Error('database close failed') })
  const release = vi.fn(h.runtime['releaseLock']!)
  h.runtime['releaseLock'] = release
  await expect(h.runtime.stop()).rejects.toThrow('database close failed')
  expect(h.runtime.store.db.isOpen).toBe(true)
  expect(checkSync(h.directory)).toBe(true)
  expect(h.runtime.sessions['guards'].size).toBeGreaterThan(0)
  expect(release).not.toHaveBeenCalled()
  await h.runtime.stop()
  expect(close).toHaveBeenCalledTimes(2)
  expect(h.runtime.store.db.isOpen).toBe(false)
  expect(h.runtime.sessions['guards'].size).toBe(0)
  expect(h.runtime.sessions['applicationDisposers'].length).toBe(0)
  const reads = vi.spyOn(h.runtime.store.tickets, 'get')
  h.ctx.emit('agent/created', { agent: h.agents.get(one.sessionId), source: 'resume' } as never)
  expect(reads).not.toHaveBeenCalled()
  expect(h.runtime.sessions['guards'].size).toBe(0)
  expect(release).toHaveBeenCalledTimes(1)
  expect(checkSync(h.directory)).toBe(false)
})

it.each(['effects', 'flush'] as const)('bounds pending %s while preserving Store, lock and guards until a real retry confirms it', async stage => {
  const h = await setup()
  await h.acceptedTicket(feishu('1', '@bot pending stop'))
  const pending = stage === 'effects' ? vi.spyOn(h.runtime.effects, 'drain') : vi.spyOn(h.ctx.sessionPersistence, 'flush')
  pending.mockImplementationOnce(() => new Promise<void>(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const stopping = expect(h.runtime.stop()).rejects.toThrow('shutdown failed')
    await vi.advanceTimersByTimeAsync(10_000)
    await stopping
    expect(h.runtime.store.db.isOpen).toBe(true)
    expect(checkSync(h.directory)).toBe(true)
    expect(h.runtime.sessions['guards'].size).toBeGreaterThan(0)
  } finally { pending.mockRestore(); vi.useRealTimers() }
  await h.runtime.stop()
  expect(h.runtime.store.db.isOpen).toBe(false)
  expect(checkSync(h.directory)).toBe(false)
})

it('does not replay a rejected guard disposer as an empty successful release', async () => {
  const h = await setup()
  h.expectFinalizerFailure()
  await h.acceptedTicket(feishu('1', '@bot rejected guard release'))
  const release = vi.spyOn(h.runtime.sessions, 'releaseGuards').mockRejectedValueOnce(new Error('guard release unconfirmed'))
  await expect(h.runtime.stop()).rejects.toThrow('shutdown failed')
  expect(h.runtime.store.db.isOpen).toBe(false)
  expect(checkSync(h.directory)).toBe(true)
  await expect(h.runtime.stop()).rejects.toThrow('shutdown failed')
  expect(release).toHaveBeenCalledTimes(1)
  expect(checkSync(h.directory)).toBe(true)
})

it('reports idle timeout without closing Store or lock, and rechecks actual idle on retry', async () => {
  const h = await setup()
  const one = await h.acceptedTicket(feishu('1', '@bot bounded stop'))
  const agent = h.agents.get(one.sessionId)!
  const idle = vi.spyOn(agent, 'whenIdle').mockImplementation(() => new Promise<void>(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const stopping = expect(h.runtime.stop()).rejects.toThrow('shutdown failed')
    await vi.advanceTimersByTimeAsync(10_000)
    await stopping
    expect(h.runtime.store.db.isOpen).toBe(true)
    expect(checkSync(h.directory)).toBe(true)
  } finally { idle.mockRestore(); vi.useRealTimers() }
  await h.runtime.stop()
})
