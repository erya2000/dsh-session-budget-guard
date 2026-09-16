/**
 * dsh-session-budget-guard — per-tree budget and burn-rate circuit breaker.
 *
 * Why it exists
 * -------------
 * A single prompt can fan out into a tree of subagents that each spend money in
 * parallel. On 2026-09-16 one session spawned 28 subagents over 20 minutes
 * (¥82, 3 494 model calls, 2 266 of them web searches) and drained the API
 * balance before anyone noticed; the Harness itself had no per-session budget.
 *
 * What it does
 * ------------
 * It watches each *session tree* (the root session plus every `origin=subagent`
 * descendant) and enforces two independent limits:
 *
 *   * cumulative spend per tree (a budget), and
 *   * spend *rate* over a sliding window (a burn-rate breaker, because a fast
 *     fan-out can outrun any cumulative number).
 *
 * Two interception points make it a real gate rather than a report:
 *
 *   * `agent/pre-step` → `{kind:'reject'}` refuses the *next* model request, so
 *     a stopped tree costs nothing more, and
 *   * `tools/pre-execute` → `{kind:'deny'}` refuses new delegations and
 *     over-quota web searches with a reason the model can read.
 *
 * Defaults are deliberately gentle: `mode: 'notify'` only logs and notifies.
 * Set `mode: 'enforce'` (and lower the thresholds) to let it stop sessions.
 *
 * No dependencies: only `node:` builtins, so it works mounted by path, installed
 * from npm, or installed straight from GitHub.
 *
 * @module dsh-session-budget-guard
 */
import { spawn } from 'node:child_process'
import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, readSync,
  renameSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { costOfCall } from './pricing.js'
import {
  aggregateTree, buildLineage, decide, delegationRefusal, descendantsOf, normalizeConfig,
  pushSample, ratePerMinute, rootOf,
} from './rules.js'

export const name = 'session-budget-guard'
export const inject = []

const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow'])
const SEARCH_TOOLS = new Set(['web_search', 'web_fetch'])
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_DIR = join(DSH_HOME, 'sessions')

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 1))
    renameSync(tmp, path)
  } catch { /* a state write must never break the guard */ }
}

export function apply(ctx, rawConfig = {}) {
  const { cfg, unknown } = normalizeConfig(rawConfig)
  const statePath = cfg.statePath || join(DSH_HOME, 'state', 'dsh-session-budget-guard.json')
  const logPath = cfg.logPath || join(DSH_HOME, 'state', 'dsh-session-budget-guard.log')
  const state = readJson(statePath, {})
  state.searches ??= {}
  state.stops ??= {}
  state.notified ??= {}

  const lineage = new Map()          // sessionId → {parent, origin, depth} (immutable per session)
  const ownCost = new Map()          // sessionId → CNY, from this plugin's own accounting
  const samples = new Map()          // rootId → [[ts, cny], …]
  const cache = new Map()            // rootId → {at, tree}
  let config = cfg
  let persistTimer = null

  const log = (text) => {
    const line = `[${new Date().toLocaleString('sv-SE')}] [session-budget-guard] ${text}`
    try {
      appendFileSync(logPath, `${line}\n`)
    } catch { /* ignore */ }
    return line
  }

  const persistLater = () => {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      writeJson(statePath, state)
    }, 2000)
    persistTimer.unref?.()
  }

  const notify = (text) => {
    const mode = config.notify
    if (mode === 'none') return
    const command = mode === 'auto' ? (process.platform === 'darwin' ? 'osascript' : null) : mode
    try {
      if (command === 'osascript') {
        const safe = String(text).replace(/["\\]/g, "'").slice(0, 400)
        spawn('/usr/bin/osascript',
          ['-e', `display notification "${safe}" with title "Session budget guard"`],
          { detached: true, stdio: 'ignore' }).unref()
      } else if (typeof command === 'string' && command.length > 0) {
        const safe = String(text).replace(/"/g, "'").slice(0, 400)
        spawn('/bin/sh', ['-c', command.replaceAll('{text}', safe)], { detached: true, stdio: 'ignore' }).unref()
      }
    } catch { /* notifications are best-effort */ }
  }

  const notifyOnce = (key, text) => {
    const last = state.notified[key] ?? 0
    if (Date.now() - last < Number(config.notifyCooldownSeconds) * 1000) return
    state.notified[key] = Date.now()
    persistLater()
    log(text)
    notify(text)
  }

  // ── lineage ────────────────────────────────────────────────────────────
  const readHead = (file) => {
    try {
      const size = statSync(file).size
      if (size === 0) return null
      const buf = Buffer.alloc(Math.min(size, 64 * 1024))
      const fd = openSync(file, 'r')
      try {
        readSync(fd, buf, 0, buf.length, 0)
      } finally {
        closeSync(fd)
      }
      // The Harness writes one record per zstd frame; decompressing a truncated
      // multi-frame buffer yields the first frame — exactly the `session` record.
      const text = zstdDecompressSync(buf).subarray(0, 8192).toString('utf8')
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue
        try {
          const rec = JSON.parse(line)
          if (rec.type === 'session') {
            return {
              id: rec.id,
              parentSession: rec.parentSession ?? null,
              origin: rec.origin ?? null,
              delegationDepth: rec.delegationDepth ?? 0,
            }
          }
        } catch { /* half-written line */ }
      }
    } catch { /* unreadable or still being written */ }
    return null
  }

  let lineageAt = 0
  const refreshLineage = () => {
    if (Date.now() - lineageAt < 5000) return
    lineageAt = Date.now()
    // Live sessions first: a session that just spawned a child may not have
    // flushed its log yet.
    try {
      for (const session of ctx.get('sessions')?.list?.() ?? []) {
        const header = session?.header
        if (header?.id && !lineage.has(session.id)) {
          lineage.set(session.id, {
            parent: header.parentSession ?? null,
            origin: header.origin ?? null,
            depth: header.delegationDepth ?? 0,
          })
        }
      }
    } catch { /* the store is optional */ }
    for (const workspace of safeReaddir(SESSIONS_DIR)) {
      const workspaceDir = join(SESSIONS_DIR, workspace)
      for (const dir of safeReaddir(workspaceDir)) {
        if (lineage.has(dir)) continue
        const info = readHead(join(workspaceDir, dir, 'session.v3.jsonl.zstd'))
        if (info?.id) lineage.set(info.id, info)
      }
    }
  }

  function safeReaddir(path) {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  }

  // ── cost ───────────────────────────────────────────────────────────────
  // Own accounting: one `llm/stream` listener, priced with the built-in table.
  ctx.on('llm/stream', (options, next) => {
    const downstream = next()
    const sessionId = options?.sessionId
    const model = options?.model
    const startedAt = Date.now()
    if (!sessionId) return downstream
    return (async function* guardAccounted() {
      let usage = null
      const iterator = downstream[Symbol.asyncIterator]()
      let completed = false
      try {
        for (;;) {
          const result = await iterator.next()
          if (result.done) break
          const chunk = result.value
          if (chunk?.type === 'usage' && chunk.usage) usage = chunk.usage
          yield chunk
        }
        completed = true
      } finally {
        if (!completed) {
          try {
            await iterator.return?.()
          } catch { /* ignore */ }
        }
        if (usage) {
          try {
            const { cny } = costOfCall(usage, model, startedAt, config)
            ownCost.set(sessionId, (ownCost.get(sessionId) ?? 0) + cny)
          } catch { /* accounting must never break a stream */ }
        }
      }
    })()
  }, { global: true })

  const costBySession = async () => {
    const costMeter = ctx.get('costMeter')
    if (costMeter?.getSessionCost) return null // handled per tree below
    const map = new Map()
    for (const [id, cny] of ownCost) map.set(id, cny)
    return map
  }

  async function treeOf(sessionId) {
    refreshLineage()
    const { rootId } = rootOf(sessionId, lineage)
    const hit = cache.get(rootId)
    if (hit && Date.now() - hit.at < 2000) return hit.tree

    // The gate compares the *tree's* deepest agent against `maxDelegationDepth`,
    // so depth always comes from the lineage, never from the caller alone.
    const structural = aggregateTree(rootId, new Map(), lineage)
    let tree = null
    const costMeter = ctx.get('costMeter')
    if (costMeter?.getSessionCost) {
      try {
        const value = await costMeter.getSessionCost(rootId)
        if (value?.found) {
          const usd = (value.own?.cost ?? 0) + (value.subagents?.cost ?? 0)
          tree = {
            rootId,
            cny: usd * Number(config.exchangeRate),
            nodes: value.subagentCount ?? 0,
            depth: structural.depth,
            ids: structural.ids,
          }
        }
      } catch { /* fall through to own accounting */ }
    }
    if (!tree) {
      const map = await costBySession()
      tree = aggregateTree(rootId, map ?? new Map(), lineage)
    }
    tree.cny = Number(tree.cny) || 0
    cache.set(rootId, { at: Date.now(), tree })
    return tree
  }

  const ratesFor = (tree) => {
    const ring = pushSample(samples.get(tree.rootId), Date.now(), tree.cny)
    samples.set(tree.rootId, ring)
    const rates = {}
    for (const seconds of config.windowsSeconds ?? []) {
      rates[seconds * 1000] = ratePerMinute(ring, Date.now(), tree.cny, seconds * 1000)
    }
    return rates
  }

  const stopTree = (tree, session, reasons) => {
    const key = tree.rootId
    const prev = state.stops[key]
    if (prev && tree.cny < Number(prev.cny) + 0.05) return true // already stopped, no new spend
    state.stops[key] = { at: Date.now(), cny: tree.cny, reasons }
    persistLater()
    if (config.mode !== 'enforce') {
      log(`[notify] would stop tree ${key.slice(0, 12)} (¥${tree.cny.toFixed(1)}): ${reasons.join('; ')}`)
      return true
    }
    const descendants = descendantsOf(key, lineage)
    try {
      const subagents = ctx.get('subagents')
      for (const child of [...descendants].reverse()) {
        try {
          subagents?.interruptByParent?.(child, lineage.get(child)?.parent ?? key, 'continuable')
        } catch { /* already finished */ }
      }
    } catch { /* ignore */ }
    try {
      session?.cancel?.({ kind: 'user' }, { keepInbox: true })
    } catch { /* ignore */ }
    log(`stopped tree ${key.slice(0, 12)} (¥${tree.cny.toFixed(1)}), interrupted ${descendants.length} subagent(s): ${reasons.join('; ')}`)
    notify(`Stopped tree ¥${tree.cny.toFixed(1)}: ${reasons.join('; ')}`.slice(0, 300))
    return true
  }

  // ── interception 1: before each model request ──────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (!config.enabled) return next()
      const session = payload?.agent?.session
      if (!session) return next()
      const tree = await treeOf(session.id)
      const decision = decide(tree, ratesFor(tree), config, state.waivers?.[tree.rootId] ?? 0)
      if (decision.warnings.length > 0) {
        notifyOnce(`warn:${tree.rootId}`, `tree ${tree.rootId.slice(0, 12)} ¥${tree.cny.toFixed(1)}: ${decision.warnings.join('; ')}`)
      }
      if (decision.level !== 'stop') {
        if (state.stops[tree.rootId]) delete state.stops[tree.rootId]
        return next()
      }
      stopTree(tree, session, decision.reasons)
      // Refusing here means no model request is made at all.
      return config.mode === 'enforce' ? { kind: 'reject' } : next()
    } catch (error) {
      log(`pre-step guard error (allowing): ${error?.message ?? error}`)
      return next()
    }
  })

  // ── interception 2: before a tool runs ─────────────────────────────────
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (!config.enabled) return next()
      const session = exec?.agent?.session
      const tool = String(exec?.name ?? '')
      if (!session) return next()

      if (DELEGATION_TOOLS.has(tool)) {
        const tree = await treeOf(session.id)
        const callerDepth = session.header?.delegationDepth ?? lineage.get(session.id)?.depth ?? 0
        const refusal = delegationRefusal(tree, callerDepth, config)
        if (refusal) {
          notifyOnce(`delegation:${tree.rootId}`, `refused ${tool}: ${refusal} (¥${tree.cny.toFixed(1)})`)
          if (config.mode === 'enforce') {
            return {
              kind: 'deny',
              reason: `Budget guard: ${refusal}. Finish this yourself instead of delegating further.`,
            }
          }
        }
        const decision = decide(tree, ratesFor(tree), config, state.waivers?.[tree.rootId] ?? 0)
        if (decision.level === 'stop') {
          stopTree(tree, session, decision.reasons)
          if (config.mode === 'enforce') {
            return { kind: 'deny', reason: `Budget guard: ${decision.reasons.join('; ')}. This session tree has been stopped.` }
          }
        }
      }

      if (SEARCH_TOOLS.has(tool)) {
        const tree = await treeOf(session.id)
        const quota = config.maxSearchesPerSession
        if (quota != null && config.mode === 'enforce') {
          const used = state.searches[session.id] ?? 0
          if (used >= Number(quota)) {
            notifyOnce(`search:${session.id}`, `refused ${tool}: search quota ${used}/${quota}`)
            return {
              kind: 'deny',
              reason: `Budget guard: web-search quota reached (${used}/${quota} for this session). Answer from what you already have.`,
            }
          }
        }
        if (quota != null) {
          state.searches[session.id] = (state.searches[session.id] ?? 0) + 1
          persistLater()
        }
        if (tree.cny >= Number(config.treeStopCny)) {
          notifyOnce(`search-cost:${tree.rootId}`, `tree ${tree.rootId.slice(0, 12)} already at ¥${tree.cny.toFixed(1)}`)
        }
      }
      return next()
    } catch (error) {
      log(`pre-execute guard error (allowing): ${error?.message ?? error}`)
      return next()
    }
  })

  if (unknown.length > 0) log(`ignoring unknown config keys: ${unknown.join(', ')}`)
  log(`mounted: mode=${config.mode} tree warn/stop ¥${config.treeWarnCny}/¥${config.treeStopCny} `
    + `rate warn/stop ¥${config.rateWarnPerMin}/¥${config.rateStopPerMin} per min `
    + `depth=${config.maxDelegationDepth ?? 'off'} nodes=${config.maxTreeNodes ?? 'off'} searches=${config.maxSearchesPerSession ?? 'off'}`)
}

export { descendantsOf, rootOf, aggregateTree, decide }
