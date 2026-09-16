/**
 * Deterministic rules for the budget guard. Everything in this file is a pure
 * function so it can be unit-tested without a Harness (`node --test test/`).
 *
 * Money is CNY everywhere in these functions. Sources that report another unit
 * convert before calling in (the cost-meter ledger reports USD).
 *
 * @module dsh-session-budget-guard/rules
 */

/** Fields every config read goes through, so a missing key never throws. */
export const DEFAULT_CONFIG = {
  enabled: true,
  /**
   * `notify` only logs and notifies; `enforce` additionally refuses the next
   * step (`agent/pre-step` → reject), denies over-quota tool calls and stops
   * the tree. Notification-first is the shipped default on purpose: cancelling
   * someone's session is a strong action to take without them asking.
   */
  mode: 'notify',
  exchangeRate: 7.2,

  // ── 会话树累计（人民币）────────────────────────────────────────────────
  // 一棵树 = root 会话 + 全部 origin=subagent 后代；普通 fork 不计。
  treeWarnCny: 20,
  treeStopCny: 50,

  // ── 烧钱速率（人民币/分钟，滑动窗）─────────────────────────────────────
  // 事故形态是「累计还没到、速度已经失控」：快速扇出来不及等累计阈值。
  windowsSeconds: [60, 180],
  rateWarnPerMin: 4,
  rateStopPerMin: 8,

  // ── 结构闸门（null = 不干预）──────────────────────────────────────────
  /** 允许的最大委派深度：1 = 子代理不许再开子代理。 */
  maxDelegationDepth: null,
  /** 一棵树内最多几个子代理。 */
  maxTreeNodes: null,
  /** 单个会话最多几次 web_search/web_fetch。 */
  maxSearchesPerSession: null,

  // ── 全局当日（人民币）──────────────────────────────────────────────────
  dailyWarnCny: 100,
  dailyStopCny: 300,

  // ── 行为 ──────────────────────────────────────────────────────────────
  /** 连续几轮越线才真的动手（防瞬时尖峰误杀）。 */
  stopStreak: 2,
  /** 同一棵树两次通知之间的最小间隔（秒）。 */
  notifyCooldownSeconds: 300,
  /** `auto`(macOS 用 osascript) | `none` | 自定义命令模板，可用 {text} 占位。 */
  notify: 'auto',
  /** 状态文件；默认 `$DSH_HOME/state/dsh-session-budget-guard.json`。 */
  statePath: null,
  /** 日志文件；默认 `$DSH_HOME/state/dsh-session-budget-guard.log`。 */
  logPath: null,
};

/** Merge user config over defaults, ignoring unknown keys loudly. */
export function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULT_CONFIG };
  const unknown = [];
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key in DEFAULT_CONFIG) cfg[key] = value;
    else unknown.push(key);
  }
  return { cfg, unknown };
}

/**
 * Build an immutable session-lineage index.
 *
 * @param {Array<{id: string, parentSession?: string|null, origin?: string|null, delegationDepth?: number}>} records
 * @returns {Map<string, {parent: string|null, origin: string|null, depth: number}>}
 */
export function buildLineage(records = []) {
  const out = new Map();
  for (const rec of records) {
    if (!rec?.id || out.has(rec.id)) continue;
    out.set(rec.id, {
      parent: rec.parentSession ?? null,
      origin: rec.origin ?? null,
      depth: Number(rec.delegationDepth) || 0,
    });
  }
  return out;
}

/** Subagent descendants of `rootId` (普通 fork 不算，环与自引用安全)。 */
export function descendantsOf(rootId, lineage) {
  const childrenOf = new Map();
  for (const [id, info] of lineage) {
    if (info.origin === 'subagent' && info.parent) {
      if (!childrenOf.has(info.parent)) childrenOf.set(info.parent, []);
      childrenOf.get(info.parent).push(id);
    }
  }
  const out = [];
  const seen = new Set([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const child of childrenOf.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

/** Walk up to the tree root; `depth` is the *starting* session's depth. */
export function rootOf(sessionId, lineage) {
  const startDepth = lineage.get(sessionId)?.depth ?? 0;
  let current = sessionId;
  const seen = new Set();
  for (let i = 0; i < 32; i += 1) {
    const info = lineage.get(current);
    if (!info || info.origin !== 'subagent' || !info.parent || seen.has(info.parent)) break;
    seen.add(current);
    current = info.parent;
  }
  return { rootId: current, depth: startDepth };
}

/**
 * Aggregate one tree from per-session costs.
 *
 * @param {string} rootId
 * @param {Map<string, number>} costBySession CNY per session id
 * @param {Map} lineage
 * @returns {{rootId: string, cny: number, nodes: number, depth: number, ids: string[]}}
 */
export function aggregateTree(rootId, costBySession, lineage) {
  const ids = [rootId, ...descendantsOf(rootId, lineage)];
  let cny = 0;
  let depth = lineage.get(rootId)?.depth ?? 0;
  for (const id of ids) {
    cny += Number(costBySession.get(id)) || 0;
    depth = Math.max(depth, lineage.get(id)?.depth ?? 0);
  }
  return { rootId, cny, nodes: ids.length - 1, depth, ids };
}

/**
 * Append `value` to a sample ring and return it (caller stores the result).
 * Keeps at most 60 samples inside `keepMs`.
 */
export function pushSample(ring, nowMs, value, keepMs = 600_000) {
  const next = (ring ?? []).filter(([ts]) => nowMs - ts <= keepMs);
  next.push([nowMs, value]);
  return next.slice(-60);
}

/**
 * Sliding-window growth rate in CNY/minute.
 * `null` when no sample is old enough to measure the window, or when the series
 * ran backwards (a new day, or a ledger reset) — neither is a growth rate.
 */
export function ratePerMinute(ring, nowMs, value, windowMs) {
  if (!Array.isArray(ring) || ring.length === 0) return null;
  const newest = ring.reduce((a, b) => (b[0] > a[0] ? b : a));
  if (value < newest[1]) return null;
  const cutoff = nowMs - windowMs;
  const older = ring.filter(([ts]) => ts <= cutoff);
  if (older.length === 0) return null;
  const [baseTs, baseValue] = older.reduce((a, b) => (b[0] > a[0] ? b : a));
  if (value < baseValue) return null;
  const minutes = Math.max((nowMs - baseTs) / 60_000, 1e-6);
  return (value - baseValue) / minutes;
}

/**
 * Decide what to do with one tree.
 *
 * @param {{cny: number, nodes: number, depth: number}} tree
 * @param {Record<number, number|null>} rates per-window CNY/minute
 * @param {object} cfg normalized config
 * @param {number} [waiverCny] spend this tree was already forgiven (see `--clear`)
 * @returns {{level: 'ok'|'warn'|'stop', reasons: string[], warnings: string[]}}
 */
export function decide(tree, rates, cfg, waiverCny = 0) {
  const reasons = [];
  const warnings = [];

  const stopCny = Number(cfg.treeStopCny) + waiverCny;
  const warnCny = Number(cfg.treeWarnCny) + waiverCny;
  if (tree.cny >= stopCny) reasons.push(`tree spend ¥${tree.cny.toFixed(1)} ≥ ¥${stopCny.toFixed(0)}`);
  else if (tree.cny >= warnCny) warnings.push(`tree spend ¥${tree.cny.toFixed(1)} ≥ warn ¥${warnCny.toFixed(0)}`);

  // `windowsSeconds` is in seconds; the caller keys `rates` by milliseconds.
  for (const seconds of cfg.windowsSeconds ?? []) {
    const rate = rates?.[Number(seconds) * 1000];
    if (rate === null || rate === undefined) continue;
    const label = `${Math.round(Number(seconds) / 60)}min`;
    if (rate >= Number(cfg.rateStopPerMin)) reasons.push(`rate ¥${rate.toFixed(1)}/min (${label}) ≥ ¥${cfg.rateStopPerMin}/min`);
    else if (rate >= Number(cfg.rateWarnPerMin)) warnings.push(`rate ¥${rate.toFixed(1)}/min (${label}) ≥ warn ¥${cfg.rateWarnPerMin}/min`);
  }

  if (cfg.maxTreeNodes != null && tree.nodes >= Number(cfg.maxTreeNodes)) {
    reasons.push(`subagents ${tree.nodes} ≥ ${cfg.maxTreeNodes}`);
  }
  if (cfg.maxDelegationDepth != null && tree.depth > Number(cfg.maxDelegationDepth)) {
    reasons.push(`delegation depth ${tree.depth} > ${cfg.maxDelegationDepth}`);
  }

  return { level: reasons.length > 0 ? 'stop' : warnings.length > 0 ? 'warn' : 'ok', reasons, warnings };
}

/** Should a new delegation be refused right now? */
export function delegationRefusal(tree, callerDepth, cfg) {
  if (cfg.maxDelegationDepth != null && callerDepth + 1 > Number(cfg.maxDelegationDepth)) {
    return `delegation depth limit (maxDelegationDepth=${cfg.maxDelegationDepth})`;
  }
  if (tree && cfg.maxTreeNodes != null && tree.nodes >= Number(cfg.maxTreeNodes)) {
    return `tree subagent limit (${tree.nodes}/${cfg.maxTreeNodes})`;
  }
  return null;
}
