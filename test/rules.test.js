import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateTree, buildLineage, decide, delegationRefusal, descendantsOf, normalizeConfig,
  pushSample, ratePerMinute, rootOf,
} from '../lib/rules.js'
import { costOfCall, isPeak } from '../lib/pricing.js'

const lineage = buildLineage([
  { id: 'root', parentSession: null, origin: null, delegationDepth: 0 },
  { id: 'a', parentSession: 'root', origin: 'subagent', delegationDepth: 1 },
  { id: 'b', parentSession: 'a', origin: 'subagent', delegationDepth: 2 },
  { id: 'fork', parentSession: 'root', origin: 'fork', delegationDepth: 1 },
])

test('descendants follow subagent chains only', () => {
  assert.deepEqual(descendantsOf('root', lineage).sort(), ['a', 'b'])
  assert.deepEqual(descendantsOf('a', lineage), ['b'])
  assert.deepEqual(descendantsOf('fork', lineage), [])
})

test('rootOf walks up to the tree root', () => {
  assert.deepEqual(rootOf('b', lineage), { rootId: 'root', depth: 2 })
  assert.deepEqual(rootOf('root', lineage), { rootId: 'root', depth: 0 })
  assert.deepEqual(rootOf('fork', lineage), { rootId: 'fork', depth: 1 })
})

test('aggregateTree sums the tree and ignores plain forks', () => {
  const costs = new Map([['root', 1], ['a', 2], ['b', 3], ['fork', 100]])
  const tree = aggregateTree('root', costs, lineage)
  assert.equal(tree.cny, 6)
  assert.equal(tree.nodes, 2)
  assert.equal(tree.depth, 2)
})

test('aggregateTree survives a cycle', () => {
  const cyclic = buildLineage([
    { id: 'x', parentSession: 'y', origin: 'subagent', delegationDepth: 1 },
    { id: 'y', parentSession: 'x', origin: 'subagent', delegationDepth: 1 },
  ])
  assert.equal(aggregateTree('x', new Map(), cyclic).nodes, 1)
})

test('ratePerMinute measures growth per minute and needs an old enough sample', () => {
  const now = 1_000_000
  const ring = [[now - 200_000, 0], [now - 10_000, 0.5]]
  assert.equal(ratePerMinute(ring, now, 1.7, 180_000), (1.7 - 0) / (200_000 / 60_000))
  assert.equal(ratePerMinute([[now - 5_000, 0]], now, 0.2, 180_000), null)
  assert.equal(ratePerMinute(ring, now, 0.1, 60_000), null) // spend cannot go down
})

test('pushSample keeps the ring bounded and drops stale samples', () => {
  let ring = []
  for (let i = 0; i < 80; i += 1) ring = pushSample(ring, i * 1000, i)
  assert.ok(ring.length <= 60)
  ring = pushSample(ring, 10_000_000, 99)
  assert.deepEqual(ring, [[10_000_000, 99]])
})

test('decide stops on cumulative spend and on rate, and warns below both', () => {
  const cfg = normalizeConfig({ treeWarnCny: 5, treeStopCny: 10, rateWarnPerMin: 1, rateStopPerMin: 3 }).cfg
  const small = { cny: 1, nodes: 0, depth: 0 }
  assert.equal(decide(small, {}, cfg).level, 'ok')

  const heavy = { cny: 7, nodes: 0, depth: 0 }
  assert.equal(decide(heavy, {}, cfg).level, 'warn')

  const overBudget = { cny: 10.4, nodes: 0, depth: 0 }
  assert.equal(decide(overBudget, {}, cfg).level, 'stop')

  const fast = { cny: 2, nodes: 0, depth: 0 }
  const stopped = decide(fast, { 60_000: 4.2 }, cfg)
  assert.equal(stopped.level, 'stop')
  assert.match(stopped.reasons[0], /rate/)
})

test('decide honours a waiver so a cleared session gets a fresh budget', () => {
  const cfg = normalizeConfig({ treeStopCny: 10 }).cfg
  assert.equal(decide({ cny: 11, nodes: 0, depth: 0 }, {}, cfg).level, 'stop')
  assert.notEqual(decide({ cny: 11, nodes: 0, depth: 0 }, {}, cfg, 11).level, 'stop')
  assert.equal(decide({ cny: 21.2, nodes: 0, depth: 0 }, {}, cfg, 11).level, 'stop')
})

test('structure gates only fire when configured', () => {
  const off = normalizeConfig({}).cfg
  assert.equal(delegationRefusal({ nodes: 99, depth: 9 }, 9, off), null)

  const on = normalizeConfig({ maxDelegationDepth: 1, maxTreeNodes: 6 }).cfg
  assert.match(delegationRefusal({ nodes: 1, depth: 1 }, 1, on), /depth/)
  assert.match(delegationRefusal({ nodes: 6, depth: 1 }, 0, on), /subagent/)
  assert.equal(delegationRefusal({ nodes: 1, depth: 1 }, 0, on), null)
})

test('normalizeConfig reports unknown keys instead of silently dropping them', () => {
  const { cfg, unknown } = normalizeConfig({ treeStopCny: 7, teeStopCny: 3 })
  assert.equal(cfg.treeStopCny, 7)
  assert.deepEqual(unknown, ['teeStopCny'])
})

test('peak windows are Beijing weekday hours and weekends are off-peak', () => {
  assert.equal(isPeak(Date.parse('2026-09-16T02:00:00Z')), true)  // Wed 10:00 CST
  assert.equal(isPeak(Date.parse('2026-09-16T04:00:00Z')), false) // Wed 12:00 CST
  assert.equal(isPeak(Date.parse('2026-09-16T06:00:00Z')), true)  // Wed 14:00 CST
  assert.equal(isPeak(Date.parse('2026-09-19T02:00:00Z')), false) // Sat
})

test('costOfCall prices DeepSeek tokens and never returns NaN for unknown models', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const peak = costOfCall(usage, 'deepseek-flash', Date.parse('2026-09-16T02:00:00Z'))
  assert.equal(peak.priced, true)
  assert.equal(peak.cny, 10) // ¥2 miss + ¥8 output

  const offPeak = costOfCall(usage, 'deepseek-flash', Date.parse('2026-09-16T04:00:00Z'))
  assert.equal(offPeak.cny, 5)

  const unknown = costOfCall(usage, 'some-other-vendor', Date.now())
  assert.equal(unknown.priced, false)
  assert.ok(Number.isFinite(unknown.cny) && unknown.cny > 0)
})
