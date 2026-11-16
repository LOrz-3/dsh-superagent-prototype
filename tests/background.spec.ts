/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { killJobs, stopBackground, stopSubagents, untilQuiet } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'
import { stopFailureParts } from '../src/executor/stop-failure.ts'

/** A context with DSH's job registry and subagents, and an idle worker agent with one live subagent, `child-1`. */
function setup(waitForTreeWork: (agent: Agent) => Promise<boolean>, drainChildren: () => Promise<void> = async () => {}) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn() } as unknown as
    Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const subagents = { waitForTreeWork: vi.fn(waitForTreeWork), stopDescendants: vi.fn(drainChildren) }
  const agents = { get: () => agent }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents, agents }
  const ctx = { get: (name: string) => services[name], agents } as unknown as Context
  return { ctx, agent, jobs, subagents }
}

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  const { ctx, agent, jobs } = setup(async () => {
    // The job settles meanwhile, and its end wakes the worker.
    jobs.end(id); (agent as { status: string }).status = 'running'
    return false
  })
  const id = jobs.run('worker-t1')
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(false)
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  let joining!: () => void
  const joined = new Promise<void>(resolve => { joining = resolve })
  const { ctx, agent } = setup(() => { joining(); return new Promise(() => {}) })
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  // The host stops while the wait for its subagents runs.
  await joined
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('joins a worker\'s subagents once for the looks that wait on them, as DSH cannot cancel the join', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForTreeWork).toHaveBeenCalledTimes(1)
})

it('reports a release timeout as failure without cancelling the root turn', async () => {
  const { ctx, agent } = setup(async () => false, () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const stopping = expect(stopSubagents(ctx, agent)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await stopping
  } finally { vi.useRealTimers() }
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('stops through the runtime barrier even with no catalog rows, and preserves the exact root', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  await stopSubagents(ctx, agent)
  expect(subagents.stopDescendants).toHaveBeenCalledWith([agent])
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('propagates subtree cleanup errors', async () => {
  const { ctx, agent } = setup(async () => false, async () => { throw new Error('teardown failed') })
  await expect(stopSubagents(ctx, agent)).rejects.toThrow('teardown failed')
})

it('refuses an unmatched runtime instead of falling back to permanent drain', async () => {
  const drainDescendants = vi.fn()
  const ctx = { get: () => ({ waitForTreeWork: async () => false, drainDescendants }) } as unknown as Context
  const agent = { id: 'worker-t1' } as Agent
  await expect(stopSubagents(ctx, agent)).rejects.toThrow('load the matching lifecycle runtime extension')
  expect(drainDescendants).not.toHaveBeenCalled()
})

it('tries every job kill and retains kill, timeout, and wait failures', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const first = jobs.run(agent.id), second = jobs.run(agent.id)
  jobs.service.wait.mockResolvedValueOnce({ id: first, owner: agent.id, status: 'running' })
    .mockRejectedValueOnce(new Error('wait failed'))
  jobs.service.kill.mockImplementationOnce(() => { throw new Error('kill failed') }).mockImplementationOnce(() => 'requested')
  const error = await killJobs(ctx, agent.id, 'stop').catch(error => error)
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors.map((item: Error) => item.message).join('; ')).toMatch(/kill failed/)
  expect(error.errors.map((item: Error) => item.message).join('; ')).toMatch(/did not stop/)
  expect(error.errors.map((item: Error) => item.message).join('; ')).toMatch(/wait failed/)
  expect(jobs.service.kill).toHaveBeenCalledWith(second, agent.id, 'stop')
})

it('preserves a sole result failure after all background resources were released', async () => {
  const result = Object.assign(new Error('provider result unavailable'), { code: 'ACTIVATION_RESULT_FAILED' })
  const { ctx, agent } = setup(async () => false, async () => { throw result })
  await expect(stopBackground(ctx, agent.id, 'stop')).rejects.toBe(result)
})

it('retains a job cleanup failure alongside a runtime-confirmed result failure', async () => {
  const result = Object.assign(new Error('provider result unavailable'), { code: 'ACTIVATION_RESULT_FAILED' })
  const { ctx, agent, jobs } = setup(async () => false, async () => { throw result })
  const job = jobs.run(agent.id)
  jobs.service.wait.mockResolvedValueOnce({ id: job, owner: agent.id, status: 'completed' })
  jobs.service.kill.mockImplementationOnce(() => { throw new Error('job kill failed') })
  const failure: unknown = await stopBackground(ctx, agent.id, 'stop').catch(error => error)
  expect(stopFailureParts(failure).results).toEqual([result])
  expect(stopFailureParts(failure).cleanup).toHaveLength(1)
  expect(stopFailureParts(failure).cleanup[0]).toBeInstanceOf(AggregateError)
})

it('attempts subtree cleanup even when stopping a shell job fails', async () => {
  const { ctx, agent, jobs, subagents } = setup(async () => false)
  const job = jobs.run(agent.id)
  jobs.service.wait.mockResolvedValueOnce({ id: job, owner: agent.id, status: 'completed' })
  jobs.service.kill.mockImplementationOnce(() => { throw new Error('kill failed') })
  await expect(stopBackground(ctx, agent.id, 'stop')).rejects.toThrow('Stopping the background work')
  expect(subagents.stopDescendants).toHaveBeenCalledWith([agent])
})
