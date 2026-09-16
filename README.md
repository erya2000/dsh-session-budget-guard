# dsh-session-budget-guard

A per-session-tree budget **and burn-rate circuit breaker** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

One prompt can fan out into a tree of subagents that all spend money at once. This plugin watches each tree — the root session plus every subagent descendant — and refuses the *next* model request (or the next delegation) when either the tree's total spend or its spend **rate** crosses a limit you set.

```
- insert:
    - id: session-budget-guard
      name: dsh-session-budget-guard
```

## Why it exists

On 2026-09-16 a single session ("research a robot dog for the farm") fanned out three levels deep: 3 subagents, then 14, then 28 — 3 494 model calls in 20 minutes, 2 266 of them web searches. It cost ¥82 and drained the API balance; the Harness had no per-session budget, and a cumulative budget alone would have been too slow to matter, because the tree was spending roughly ¥4/minute.

That is why there are two independent gates: **cumulative spend** and **spend rate**.

## Install

```sh
dsh plugin --profile web add dsh-session-budget-guard     # npm (once published)
dsh plugin --profile web add github:naizhierchou/dsh-session-budget-guard
```

Or mount it by path from a local checkout (no install step):

```yaml
# ~/.dsh/cordis.patch.yml
- insert:
    - id: session-budget-guard
      name: /absolute/path/to/dsh-session-budget-guard/lib/index.js
```

Restart the Harness once after installing (patch layers apply live, but the first
mount of a new package needs a boot).

## Configuration

Every key is optional; the defaults live in `lib/rules.js`. Unknown keys are
logged and ignored rather than silently dropped.

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `notify` | `notify` = log + notify only. `enforce` = also refuse the next step, deny over-quota delegations/searches and stop the tree. |
| `enabled` | `true` | Master switch. |
| `treeWarnCny` | `20` | Warn once per tree at this cumulative spend. |
| `treeStopCny` | `50` | Stop the tree at this cumulative spend. |
| `rateWarnPerMin` | `4` | Warn when the tree grows faster than ¥4/min. |
| `rateStopPerMin` | `8` | Stop the tree when it grows faster than ¥8/min. |
| `windowsSeconds` | `[60, 180]` | Sliding windows used for the rate, in seconds. |
| `maxDelegationDepth` | `null` (off) | Deepest allowed subagent depth. `1` means subagents may not spawn subagents. |
| `maxTreeNodes` | `null` (off) | Most subagents allowed in one tree. |
| `maxSearchesPerSession` | `null` (off) | Most `web_search`/`web_fetch` calls allowed per session. |
| `dailyWarnCny` / `dailyStopCny` | `100` / `300` | Reported in warnings for the whole day across trees. |
| `stopStreak` | `2` | Consecutive over-limit checks before acting. |
| `notifyCooldownSeconds` | `300` | Minimum gap between notifications for the same tree. |
| `notify` | `auto` | `auto` (macOS: `osascript`), `none`, or a shell command template containing `{text}`. |
| `exchangeRate` | `7.2` | Used to convert the cost-meter ledger (USD) into CNY. |
| `statePath` / `logPath` | `$DSH_HOME/state/...` | Where persistent state and the log live. |

A configuration tuned for enforcement (this is what the incident above led to):

```yaml
config:
  mode: enforce
  treeWarnCny: 5
  treeStopCny: 10
  rateWarnPerMin: 1.5
  rateStopPerMin: 3
  maxDelegationDepth: 1
  maxTreeNodes: 6
  maxSearchesPerSession: 40
```

## What it does when a limit is hit

1. `agent/pre-step` returns `{kind:'reject'}` — **the next model request never happens**, so a stopped tree stops costing money immediately.
2. `tools/pre-execute` returns `{kind:'deny', reason}` for a new `subagent` / `subagent_fork` / `workflow` call past the structure limits, or for a `web_search`/`web_fetch` past the quota. The reason is model-visible, so the agent adapts instead of retrying blindly.
3. Descendants are interrupted deepest-first, then the session turn is cancelled (`keepInbox`, so queued messages survive).
4. The event is written to the log, and a notification is sent.

In `notify` mode only step 4 happens.

## Where the numbers come from

* If the [`dsh-cost-meter`](https://github.com/dsh-market/dsh-market) plugin is mounted, the guard reads its ledger through the `costMeter` service (complete history, user-edited prices; the ledger is USD and is converted with `exchangeRate`).
* Otherwise the guard prices calls itself from the `llm/stream` waterfall using DeepSeek list prices (peak/off-peak, Beijing time) — no dependency, but the totals start when the plugin loads.

Lineage (which session is whose subagent) is read from each session log's **first record** — `id`, `parentSession`, `origin`, `delegationDepth` — plus the live session store. Message content is never read.

## Limits

* It is an in-process guard: it stops a tree that is running, it does not resurrect accounting after a Harness restart.
* `notify` mode is the default. Turning on `enforce` means the plugin will cancel a session; tune the thresholds to your own traffic first (run in `notify` for a day and read the log).
* Rate limits need at least one sample older than the window, so the first minute of a fresh guard cannot trip on rate — cumulative and structure limits still apply.
* Plain forks (`origin=fork`) are deliberately excluded from tree aggregation.

## Tests

```sh
node --test
```

18 tests cover the rule engine (lineage, tree aggregation including cycles, sliding-window rate, threshold decisions, waivers, structure gates) and the plugin wiring against a fake host (reject/deny behaviour, search quota, own `llm/stream` accounting).

## License

MIT
