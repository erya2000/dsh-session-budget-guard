# dsh-session-budget-guard

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**会话树预算 + 烧钱速率熔断**插件。

一句 prompt 可以扇出成一棵子代理树，同时花钱。本插件盯住每棵树（root 会话 + 全部子代理后代），
在**累计花费**或**烧钱速率**越线时，拒掉**下一次模型请求**（或下一次委派）。

## 为什么会有它

2026-09-16，一个「研究机器狗」的会话三层扇出：3 个 → 14 个 → 28 个子代理，20 分钟 3 494 次模型调用、
其中 2 266 次联网检索，烧掉 ¥82 并把 API 余额打穿。当时 Harness 没有任何按会话的预算闸门；
而且光有累计预算也不够——那棵树大约每分钟花 ¥4，等累计到阈值时钱已经没了。

所以有两道独立的闸门：**累计花费**和**烧钱速率**。

## 安装

```sh
dsh plugin --profile web add dsh-session-budget-guard     # npm（发布后）
dsh plugin --profile web add github:erya2000/dsh-session-budget-guard
```

或者直接用绝对路径挂本地目录（不需要安装）：

```yaml
# ~/.dsh/cordis.patch.yml
- insert:
    - id: session-budget-guard
      name: /绝对路径/dsh-session-budget-guard/lib/index.js
```

装好后重启一次 Harness（补丁层是热生效的，但首次挂载一个新包要启动一次）。

## 配置

所有键都可省略，默认值在 `lib/rules.js`。写错的键会被记进日志并忽略，不会静默吃掉。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `mode` | `notify` | `notify` = 只记日志 + 通知；`enforce` = 还会拒步骤、拒超额委派/检索、停掉整棵树 |
| `treeWarnCny` | `20` | 单树累计到多少发预警 |
| `treeStopCny` | `50` | 单树累计到多少熔断 |
| `rateWarnPerMin` | `4` | 树每分钟涨超过多少发预警 |
| `rateStopPerMin` | `8` | 树每分钟涨超过多少熔断 |
| `windowsSeconds` | `[60, 180]` | 速率用的滑动窗（秒） |
| `maxDelegationDepth` | `null`（关） | 允许的最大委派深度；`1` = 子代理不许再开子代理 |
| `maxTreeNodes` | `null`（关） | 一棵树最多几个子代理 |
| `maxSearchesPerSession` | `null`（关） | 单个会话最多几次 `web_search`/`web_fetch` |
| `dailyWarnCny` / `dailyStopCny` | `100` / `300` | 当日全树合计的预警/熔断口径 |
| `stopStreak` | `2` | 连续几轮越线才动手（防瞬时尖峰误杀） |
| `notifyCooldownSeconds` | `300` | 同一棵树两次通知的最小间隔 |
| `notify` | `auto` | `auto`（macOS 走 `osascript`）、`none`，或带 `{text}` 占位的自定义命令 |
| `exchangeRate` | `7.2` | 把 cost-meter 账本（美元）折成人民币 |
| `statePath` / `logPath` | `$DSH_HOME/state/...` | 状态与日志位置 |

上面那次事故之后，本机在用的收紧配置长这样：

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

## 越线之后会发生什么

1. `agent/pre-step` 返回 `{kind:'reject'}` —— **下一次模型请求根本不发生**，被停的树立刻不再花钱。
2. `tools/pre-execute` 对超出结构上限的 `subagent`/`subagent_fork`/`workflow`、或超配额的
   `web_search`/`web_fetch` 返回 `{kind:'deny', reason}`；`reason` 模型可见，它会换个做法而不是硬撞。
3. 自底向上中断子代理，然后取消当前轮（`keepInbox`，排队等着的消息保留）。
4. 写日志 + 发通知。

`notify` 模式下只做第 4 步。

## 数字从哪来

* 如果装了 [`dsh-cost-meter`](https://github.com/dsh-market/dsh-market)，走它的 `costMeter` 服务读账本
  （历史完整、价格可被用户改过；账本是美元，按 `exchangeRate` 折算）。
* 否则插件自己在 `llm/stream` 瀑布上计价（DeepSeek 官方峰谷价、北京时间），零依赖，
  但累计从插件加载那一刻开始。

父子关系只读每个会话日志的**第一条记录**（`id` / `parentSession` / `origin` / `delegationDepth`）
加活动会话表；**不读任何消息内容**。

## 已知边界

* 这是进程内闸门：能停住正在跑的树，但 Harness 重启后不会重建历史账。
* 默认 `notify`，不会真的停任何东西；要 `enforce` 请先用 `notify` 跑一天、看日志、再按自己的流量调阈值。
* 速率闸门需要至少一个比窗口更早的采样，刚加载的第一分钟只能靠累计与结构闸门。
* 普通 fork（`origin=fork`）不计入树的聚合。

## 测试

```sh
node --test
```

18 条：规则引擎（父子链、含环的树聚合、滑窗速率、阈值判定、豁免基线、结构闸门）
+ 插件接线（对假宿主断言 reject/deny、检索配额、自己的 `llm/stream` 记账）。

## 许可

MIT
