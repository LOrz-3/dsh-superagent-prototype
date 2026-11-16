import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Sessions, Store, Effects, Prompts, HealthBoard } from './artifact/lib/adapter.mjs'

export const name = 'real-agent-guard-owner-proof'
export const inject = ['agents', 'tools', 'sessionPersistence']

export function apply(ctx, config) {
  const ready = ctx.get('appReady'), exit = ctx.get('appExit')
  let running
  const off = ready.onReady(() => {
    running = run(ctx, config).then(() => exit(0), () => exit(1))
  })
  ctx.effect(() => () => { off(); return running }, 'guard ownership probe')
}

async function run(ctx, config) {
  const result = { assertionsStatus: 'running', modelRequests: 0, checks: {}, peerVersion: '0.2.2-rc.3' }
  let actor, owner, sessions, store, closed = false, closing = false
  let executions = 0, storeReads = 0, ownerEvents = 0, cleanupThrew = false
  const check = (name, condition) => { assert.ok(condition, name); result.checks[name] = true }
  const observedRequest = ctx.on('agent/request', (_request, next) => { result.modelRequests++; return next() })
  try {
    store = new Store(join(config.directory, 'guard-store.sqlite'))
    const originalGet = store.tickets.get.bind(store.tickets)
    store.tickets.get = (...args) => { storeReads++; return originalGet(...args) }
    actor = await ctx.agents.create({ sessionId: SessionId('worker-guard-owner-proof'), meta: { cwd: config.directory } })
    const agent = actor.agent
    result.sessionId = agent.id
    agent.ctx.tools.register({ name: 'pwsh', description: 'Controlled keyless ownership probe; no process execution',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        render: () => [{ type: 'text', text: 'probe completed' }] },
      execute: async () => { executions++; return { ok: true } } })
    const call = async id => {
      const batch = await ctx.get('tools').execute({ calls: [{ type: 'tool-call', id: ToolCallId(id), name: 'pwsh', arguments: {} }],
        agent, signal: new AbortController().signal })
      return batch.results[0].result
    }
    const first = await call('guard-before-owner')
    check('realRegistryExecutesScopedTool', !first.isError && executions === 1)
    let defaultStepReached = false
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Fixed closing-admission probe' }] })
    const dispatchStep = () => agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
      modelSelection: { provider: 'weinexus', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' },
    }, async () => { defaultStepReached = true; return { kind: 'enter', messages: [message] } })
    const board = new HealthBoard(), effects = new Effects(store, board)
    const prompts = new Prompts(store, () => 4000, () => undefined, () => false)
    owner = await ctx.plugin({ name: 'throwing-superagent-owner', inject: ['tools'], apply(appCtx) {
      sessions = new Sessions({ context: appCtx, store, effects, prompts, health: board.claim('models'),
        masterId: 'unused-master', lifetime: new AbortController().signal,
        closing: () => closing, environment: () => [], tools: () => [] })
      sessions.workOnly(agent, 'guard-owner-proof')
      appCtx.on('tools/change', () => { ownerEvents++ })
      appCtx.effect(() => () => { closing = true; cleanupThrew = true; throw new Error('Injected owner cleanup remains unverified') },
        'synthetic failed application stop')
    } })
    const initialStep = await dispatchStep()
    check('actualStepDispatchAllowsBeforeClosing', initialStep.kind === 'enter' && defaultStepReached)
    ctx.emit('tools/change')
    check('applicationListenerInitiallyMounted', ownerEvents > 0)
    const outcome = await Promise.allSettled([owner.dispose()])
    result.ownerDisposeRejected = outcome[0].status === 'rejected'
    check('ownerCleanupActuallyThrew', cleanupThrew && closing)
    const afterDispose = ownerEvents
    ctx.emit('tools/change')
    check('pluginOwnedListenerWasRemoved', ownerEvents === afterDispose)
    check('realAgentStillRegistered', ctx.agents.get(agent.id) === agent)
    check('guardStillHeldByAgentScope', sessions.guards.has(agent))
    store.close(); closed = true
    check('actualSQLiteStoreClosed', !store.db.isOpen)
    const readsBefore = storeReads
    const denied = await call('guard-after-owner')
    check('actualRegistryGuardRejectsAfterOwnerFailure', denied.isError
      && denied.content.some(block => block.type === 'text' && block.text.includes('stopping')))
    check('guardDoesNotReadClosedStore', storeReads === readsBefore)
    check('rejectedToolBodyDidNotRun', executions === 1)
    defaultStepReached = false
    const decision = await dispatchStep()
    check('agentOwnedStepGuardRejectsNewWork', decision.kind === 'reject' && !defaultStepReached && result.modelRequests === 0)
    result.rejectedSteps = decision.kind === 'reject' ? 1 : 0
    result.stepEvidence = 'actual Agent scope dispatch, no model turn claimed'
    check('stepDispatchDidNotReadClosedStore', storeReads === readsBefore)
    check('probeWasKeyless', result.modelRequests === 0)
    result.assertionsStatus = 'passed'
  } catch (error) {
    result.assertionsStatus = 'failed'
    result.error = { name: error.name, code: error.code ?? 'OWNERSHIP_PROOF_FAILED',
      check: /^[A-Za-z][A-Za-z0-9]{0,100}$/.test(error.message) ? error.message : 'private diagnostic withheld' }
  } finally {
    observedRequest()
    if (owner) await Promise.allSettled([owner.dispose()])
    if (actor) await actor.dispose()
    if (sessions) await sessions.releaseGuards()
    if (store && !closed) store.close()
    result.remainingAgents = ctx.agents.list().length
    await ctx.sessionPersistence.flush()
    await writeFile(config.evidence, JSON.stringify(result, null, 2) + '\n')
  }
  if (result.assertionsStatus !== 'passed') throw new Error('Guard ownership probe failed')
}
