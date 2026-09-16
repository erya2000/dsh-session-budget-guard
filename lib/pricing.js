/**
 * Token pricing for the guard's own accounting path.
 *
 * The guard is a *circuit breaker*, not a billing system: it only needs the
 * cost of the sessions it is watching, and only while it is loaded. When the
 * `dsh-cost-meter` plugin is mounted the guard prefers its ledger (complete
 * history, user-edited prices); this table is the dependency-free fallback so
 * the guard still works on a bare Harness.
 *
 * Rates are CNY per million tokens, DeepSeek list prices as of 2026-09:
 *   off-peak  hit ¥0.02 / miss ¥1 / output ¥4
 *   peak      hit ¥0.04 / miss ¥2 / output ¥8
 * Peak = Beijing time, weekdays 09:00–12:00 and 14:00–18:00; weekends are
 * off-peak all day. Cache writes are billed as misses.
 *
 * @module dsh-session-budget-guard/pricing
 */

export const DEEPSEEK_RATES = {
  offPeak: { hit: 0.02, miss: 1.0, output: 4.0 },
  peak: { hit: 0.04, miss: 2.0, output: 8.0 },
};

const PEAK_WINDOWS = [[9, 12], [14, 18]];

/** Beijing wall-clock parts for one instant. */
function beijingParts(atMs) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    weekday: 'short',
    hour: 'numeric',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour) % 24, weekday: parts.weekday };
}

/** Is `atMs` inside a DeepSeek peak-priced window? */
export function isPeak(atMs) {
  const { hour, weekday } = beijingParts(atMs);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end);
}

/** Normalize one Harness usage chunk into the four billable buckets. */
export function bucketsOf(usage = {}) {
  return {
    input: Number(usage.inputTokens) || 0,
    output: Number(usage.outputTokens) || 0,
    cacheRead: Number(usage.cacheReadTokens) || 0,
    cacheWrite: Number(usage.cacheWriteTokens) || 0,
  };
}

/**
 * Cost of one call in CNY.
 *
 * @param {object} usage Harness usage chunk
 * @param {string} model model id as reported by the route
 * @param {number} atMs request start (peak/off-peak is decided at request time)
 * @param {object} [config] optional `pricePerMillion` override map
 * @returns {{cny: number, priced: boolean}}
 */
export function costOfCall(usage, model, atMs, config = {}) {
  const buckets = bucketsOf(usage);
  const override = config.pricePerMillion?.[model] ?? config.pricePerMillion?.default;
  const prices = override ?? (String(model ?? '').toLowerCase().includes('deepseek')
    ? (isPeak(atMs) ? DEEPSEEK_RATES.peak : DEEPSEEK_RATES.offPeak)
    : null);
  if (!prices) {
    // Unknown vendor: count tokens as a miss at the off-peak list price so a
    // mispriced route still trips the breaker rather than silently free.
    return { cny: (buckets.input + buckets.cacheWrite) / 1e6 * DEEPSEEK_RATES.offPeak.miss
      + buckets.output / 1e6 * DEEPSEEK_RATES.offPeak.output
      + buckets.cacheRead / 1e6 * DEEPSEEK_RATES.offPeak.hit, priced: false };
  }
  const cny = (buckets.input + buckets.cacheWrite) / 1e6 * Number(prices.miss ?? 0)
    + buckets.output / 1e6 * Number(prices.output ?? 0)
    + buckets.cacheRead / 1e6 * Number(prices.hit ?? 0);
  return { cny, priced: true };
}
