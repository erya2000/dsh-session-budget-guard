import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** Minimal Cordis-shaped host: records listeners, answers `get()` from a table. */
function fakeContext(services = {}) {
  const handlers = new Map()
  return {
    handlers,
    on(event, fn) {
      handlers.set(event, fn)
      return () => handlers.delete(event)
    },
    get(key) {
      return services[key]
    },
  }
}

const SESSION = { id: 'session-root', header: { origin: null, parentSession: null, delegationDepth: 0 } }
const CHILD = { id: 'child-1', header: { origin: 'subagent', parentSession: 'session-root', delegationDepth: 1 } }

function mount(config = {}, services = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'budget-guard-'))
  const ctx = fakeContext(services)
  apply(ctx, {
    mode: 'enforce',
    notify: 'none',
    statePath: join(dir, 'state.json'),
    logPath: join(dir, 'guard.log'),
    ...config,
  })
  return ctx
}

const costMeter = (ownUsd, subagentUsd, nodes = 0) => ({
  async getSessionCost() {
    return { found: true, own: { cost: ownUsd, calls: 1 }, subagents: { cost: subagentUsd, calls: 1 }, subagentCount: nodes }
  },
})

test('refuses the next step (no model request) once a tree is over budget', async () => {
  const ctx = mount({ treeStopCny: 10 }, { costMeter: costMeter(1, 5) }) // ¥6 × 7.2 = ¥43.2
  const preStep = ctx.handlers.get('agent/pre-step')
  const decision = await preStep({ agent: { session: SESSION } }, async () => ({ kind: 'enter' }))
  assert.deepEqual(decision, { kind: 'reject' })
})

test('lets a cheap tree through and ignores it in notify mode', async () => {
  const cheap = mount({ treeStopCny: 10 }, { costMeter: costMeter(0.2, 0.1) })
  assert.deepEqual(
    await cheap.handlers.get('agent/pre-step')({ agent: { session: SESSION } }, async () => ({ kind: 'enter' })),
    { kind: 'enter' },
  )

  const notifying = mount({ mode: 'notify', treeStopCny: 10 }, { costMeter: costMeter(1, 5) })
  assert.deepEqual(
    await notifying.handlers.get('agent/pre-step')({ agent: { session: SESSION } }, async () => ({ kind: 'enter' })),
    { kind: 'enter' },
  )
})

test('denies a delegation past the depth limit with a model-visible reason', async () => {
  const ctx = mount({ maxDelegationDepth: 1 }, { costMeter: costMeter(0, 0) })
  const preTool = ctx.handlers.get('tools/pre-execute')
  const denied = await preTool({ name: 'subagent', agent: { session: CHILD } }, async () => ({ kind: 'allow' }))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /depth/i)

  const allowed = await preTool({ name: 'subagent', agent: { session: SESSION } }, async () => ({ kind: 'allow' }))
  assert.deepEqual(allowed, { kind: 'allow' })
})

test('denies searches past the per-session quota and counts allowed ones', async () => {
  const ctx = mount({ maxSearchesPerSession: 2 }, { costMeter: costMeter(0, 0) })
  const preTool = ctx.handlers.get('tools/pre-execute')
  const run = (name) => preTool({ name, agent: { session: SESSION } }, async () => ({ kind: 'allow' }))

  assert.deepEqual(await run('web_search'), { kind: 'allow' })
  assert.deepEqual(await run('web_search'), { kind: 'allow' })
  const third = await run('web_search')
  assert.equal(third.kind, 'deny')
  assert.match(third.reason, /quota/i)
  // Unrelated tools are never counted or blocked.
  assert.deepEqual(await run('bash'), { kind: 'allow' })
})

test('unknown config keys are tolerated, missing ones fall back to defaults', () => {
  const ctx = mount({ teeStopCny: 1, treeStopCny: 12 }, { costMeter: costMeter(0, 0) })
  assert.ok(ctx.handlers.has('agent/pre-step'))
  assert.ok(ctx.handlers.has('tools/pre-execute'))
  assert.ok(ctx.handlers.has('llm/stream'))
})

test('its own llm/stream accounting trips the breaker without dsh-cost-meter', async () => {
  const ctx = mount({ treeStopCny: 5 }) // no costMeter service at all
  const wrap = ctx.handlers.get('llm/stream')
  const stream = wrap(
    { sessionId: SESSION.id, model: 'deepseek-flash', provider: 'deepseek-official' },
    () => (async function* chunks() {
      yield { type: 'text', text: 'hi' }
      yield { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }
    })(),
  )
  for await (const _chunk of stream) { /* drain */ }

  const decision = await ctx.handlers.get('agent/pre-step')({ agent: { session: SESSION } }, async () => ({ kind: 'enter' }))
  assert.deepEqual(decision, { kind: 'reject' })
})
