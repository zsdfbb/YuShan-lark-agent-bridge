# YuShan 适配 — 设计

> 日期：2026-11-11
> 上下文：[`context.md`](./context.md)
> 清单：[`improvement-plan.md`](./improvement-plan.md)
> 决策：[`adr-001-yushan-as-third-agent.md`](./adr-001-yushan-as-third-agent.md)
> 状态：设计完成，待实现
> 基线：bridge `5898681`（v0.7.1）／ YuShan `target/release/ys-coding-agent`（2026-11-10 构建）

---

## 1. 目标与判据

让 `lark-channel-bridge` 把 `ys-coding-agent` 当作第三种受支持 agent，与 `claude` / `codex` 并列。
消费方式是既有的：**每条用户消息 spawn 一个短命进程，解析 stdout 事件流，`SIGTERM` 收尾**。

| # | 判据 | 验收形态 |
|---|---|---|
| A1 | 首轮跑通：飞书发任务 → 卡片出现正文与工具过程 | 一次 `--json` 进程，`RunFinished` 后卡片终态为 done |
| A2 | 续轮上下文连续 | 第二轮带 `--resume <id>`，模型能引用第一轮内容 |
| A3 | 取消干净 | 用户点停止 → `SIGTERM` → 进程 75 退出 → 卡片终态 interrupted，无孤儿进程 |
| A4 | 预检不误报 | profile 启动时 `checkAvailability` 返回 ok，不因 `--version` 缺失而失败 |
| A5 | 不污染既有 agent | claude / codex 的 profile、会话、测试全部照旧 |

**非目标**：不改 YuShan 的 loop / 工具 / 事件层；不扩 `AgentEvent` 契约；不实现 sandbox 三档；
不做 YuShan 会话历史的富展示。

---

## 2. 决定设计的三条实测事实

这三条把「要改 YuShan 多少」压到了最小。全部由 `docs/arch/yushan-adapter/` 生成期实测确认，
不是从文档推测的。

### 事实 1：`--json` 已经是为 bridge 设计的 headless 接口

YuShan 的 `docs/design-final/headless-worker-contract.md` 开篇即写「服务
`../YuShan-lark-agent-bridge`」。实测一次真实运行：

```
$ ys-coding-agent --json "用 ls 看一下当前目录，然后一句话总结"
{"id":"1794328465_333895000","type":"session"}
{"source":"agent","turn":1,"event":{"UserMessage":{"message":{"role":"User","content":[{"Text":{"text":"用 ls 看一下当前目录，然后一句话总结"}}]}}}}
{"source":"agent","turn":1,"event":{"RoundStarted":{"round":1}}}
{"source":"agent","turn":1,"event":{"RoundUsage":{"purpose":"turn","round":1,"usage":{"input_tokens":7814,"output_tokens":37,"prompt_cache_hit_tokens":0,"reasoning_tokens":0}}}}
{"source":"agent","turn":1,"event":{"ToolCall":{"call":{"id":"chatcmpl-tool-b772253bd391b1f9","name":"ls","arguments":{"path":"."}}}}}
{"source":"agent","turn":1,"event":{"ToolResult":{"id":"chatcmpl-tool-b772253bd391b1f9","result":{"content":"err.log","is_error":false}}}}
{"source":"agent","turn":1,"event":{"ModelThinkingDelta":{"text":"Just"}}}
{"source":"agent","turn":1,"event":{"ModelTextDelta":{"text":"当前"}}}
{"source":"agent","turn":1,"event":{"RunFinished":{"stop_reason":"Completed","usage":{"input_tokens":15678,"output_tokens":65,"prompt_cache_hit_tokens":6,"reasoning_tokens":6},"rounds":2}}}
```

⇒ **bridge 需要的四类信息全在**：会话 id（首行）、正文流（`ModelTextDelta`）、
工具过程（`ToolCall` / `ToolResult`）、用量与终局（`RoundUsage` / `RunFinished`）。
**不需要改 YuShan 的事件层**。

### 事实 2：`SIGTERM` 已经走「abort 本回合 + 75 退出」正确路径

实测（Python 起进程，8 秒后 `SIGTERM`，目标是让模型跑一个 `sleep 30`）：

```
EXIT CODE: 75
STDOUT TAIL:
  {"tool_result":{…"content":"aborted by user","is_error":true}}
  {"event":{"RunFinished":{"stop_reason":"Cancelled","usage":{…},"rounds":1}}}
STDERR:
  SIGTERM received — aborting this turn
```

⇒ A3 已经满足，adapter 只需把 `stop_reason: Cancelled` 译成 `terminationReason: 'interrupted'`。
**YuShan 侧零改动**。（对比：`headless-worker-contract.md` 记录的早期形态是「硬停、75 未实现」，
现已落地。）

### 事实 3：`YUSHAN_MODEL` / `YUSHAN_SESSIONS_DIR` 覆盖了模型与会话目录

实测两者均生效：

```
$ YUSHAN_MODEL=deepseek-v4.1-flash ys-coding-agent --json "说一个字"   # 正常跑
$ YUSHAN_SESSIONS_DIR=/tmp/x ys-coding-agent --json "说一个字"         # 会话落到 /tmp/x/*.jsonl
```

⇒ 模型选择（`AgentRunOptions.model`）与 per-profile 会话隔离**都不需要 YuShan 加 CLI flag**。
上一版清单里 G3 的判断作废：它不是缺口。

---

## 3. 仍存在的缺口与处置

| # | 缺口 | 实测证据 | 处置 |
|---|---|---|---|
| **G1** | 无 `--version` | `--version` ⇒ stderr `未知参数`，**退出码 1** | **改 YuShan 加**（Y1，约 5 行）。绕法 `args:['--help']` 能通（退出 0、首行非空），但 `/status` 会把标题当版本号 |
| **G2** | `--` 不是终止符 | `--json -- "任务文本"` ⇒ 任务文本为 `"-- 任务文本"`（`--` 被并入） | **改 YuShan 加**（Y2，约 3 行）。当前真实风险很窄，见下 |
| **G3** | `ModelStreamDiscarded` 无 bridge 对应物 | `event.rs:100`；bridge 的 `text` 是累加的（`card/run-state.ts:55`） | **bridge 侧解决**（B1 的 B 案：攒到终局发 `final_text`），不改 YuShan、不扩契约 |
| **G4** | 无 sandbox / 权限 CLI | 工具审批固定 `AutoApprove`（`main.rs:1263`） | **本轮不做**；`yushanCapability` 声明 `maxAccess:'full'` 让 `clampAccess` 语义正确 |

### G2 的真实风险边界（实测收窄）

我逐条试了「整个 prompt 恰好等于某个 flag」：

| prompt | 结果 |
|---|---|
| `-foo 任务` | ✅ 正常（`split_leading_flags` 在 `_ => break` 处停止，只吞三个精确匹配的 flag） |
| `--stats` | ❌ `Error: "--json 需要一个任务参数"` |
| `--debug` | ❌ 同上 |
| `--resume` | ❌ 同上 |

⇒ 唯一会炸的输入是**整个任务文本恰好等于 `--stats` / `--debug` / `--resume` 之一**。
bridge 的 prompt 恒为 `<bridge_context>…\n\n## user_message\n\n<用户消息>`，首 token 永远不是裸 flag，
**实操上不会撞**。故 Y2 从「必做」降为「建议做」（消除理论风险 + 让语义完整）。

同理，实测 200 KB 的 argv 任务能正常跑通，**长度不是问题**。

---

## 4. 总体设计

### 4.1 分层

```
┌─ bridge ────────────────────────────────────────────────┐
│ bot/channel → run-flow → run-executor                   │
│                              ↓ AgentRunOptions           │
│            ┌──────────────────────────────────┐          │
│            │ YushanAdapter  (新)              │          │
│            │  ├─ argv 构造                    │          │
│            │  ├─ env 构造                     │          │
│            │  ├─ 子进程生命周期 (SIGTERM/宽限)│          │
│            │  └─ YushanTranslator (新)        │          │
│            │       NDJSON → AgentEvent        │          │
│            └──────────────────────────────────┘          │
│                              ↓ AgentEvent（既有契约）    │
│    card/run-state · bot/cot · commands（全部不改）       │
└──────────────────────────────────────────────────────────┘
                              ↕ 进程边界 + NDJSON
┌─ YuShan ────────────────────────────────────────────────┐
│ ys-coding-agent --json [--resume <id>] "<prompt>"        │
│   → session 首行 + Envelope 流 + 退出码 0/1/75           │
└──────────────────────────────────────────────────────────┘
```

关键：**唯一的翻译边界在 `YushanTranslator`**。它之上全是既有代码（零改动），
它之下是 YuShan 原样输出（零改动）。

### 4.2 新增文件

| 文件 | 职责 | 行数估计 |
|---|---|---|
| `src/agent/yushan/adapter.ts` | `AgentAdapter` 实现：预检、argv/env、spawn、SIGTERM、终局兜底 | ~230（骨架抄 `codex/adapter.ts`） |
| `src/agent/yushan/translate.ts` | `YushanTranslator`：NDJSON → `AgentEvent[]` | ~180 |
| `src/agent/yushan/argv.ts` | `buildYushanArgs()`，纯函数便于单测 | ~40 |
| `src/session/yushan-history.ts` | 读 `~/.yushan/sessions/*.jsonl` 供 `/resume` 列表 | ~70 |
| `tests/unit/agent/yushan-translate.test.ts` | fixture 驱动 | ~200 |
| `tests/unit/agent/yushan-argv.test.ts` | | ~60 |
| `tests/unit/agent/yushan-prepare-run.test.ts` | 照抄 `codex-prepare-run.test.ts` | ~80 |

### 4.3 argv 构造

```ts
// src/agent/yushan/argv.ts
export function buildYushanArgs(input: {
  sessionId?: string;
  prompt: string;
  /** Y2 落地后为 true：用 `--` 终止 flag 解析。 */
  doubleDash?: boolean;
}): string[] {
  const args = ['--json'];
  if (input.sessionId) args.push('--resume', input.sessionId);
  if (input.doubleDash) args.push('--');
  args.push(input.prompt);
  return args;
}
```

**顺序必须严格如下**（`split_leading_flags` 只认 flag 区里的三个 flag，遇到非 flag 即停）：

1. `--json`（子命令，必须在首位）
2. `--resume <id>`（可选；`id` 不能在末尾，否则会被当成裸 `--resume` 走 picker —— 
   实测 `--resume <id> <任务>` 取 id，因为「之后还留着任务文本」）
3. `--`（可选，Y2 后）
4. `<prompt>`（**恰好一个 token**，整段提示词）

**prompt 不走 stdin**：YuShan 明确注明 `-` 是「读 stdin 的占位，本轮不支持」（`main.rs:356`）。
`child.stdin.end()` 仍要调用，否则子进程可能等 stdin。

### 4.4 env 构造

```ts
const env = mergeProcessEnv(process.env, {
  ...buildLarkChannelEnv(this.larkChannel),
  // 会话隔离，与 codex 的 CODEX_HOME 同思路（事实 3 实测有效）
  YUSHAN_SESSIONS_DIR: join(this.profileStateDir, 'yushan-sessions'),
  // 模型选择：bridge 的 model 通路映射到已存在的环境变量（事实 3）
  ...(opts.model ? { YUSHAN_MODEL: opts.model } : {}),
  // bridge 是程序化调用方，结构化日志会污染 stderr 且无消费者
  YUSHAN_DEBUG: '0',
});
```

`YUSHAN_DEBUG=0` 的理由：该变量默认开启结构化日志；bridge 只把 stderr 当**失败诊断**读
（`codex/adapter.ts:130` 的 `log.warn('agent','stderr')`），开启后每回合会灌入大量日志行。

> ⚠️ **已验证（生成期实测）**：`YUSHAN_SESSIONS_DIR` 与 `--resume` **可以共存**。
> 实测：在 `YUSHAN_SESSIONS_DIR=/tmp/ystest/sessR1` 下首轮让模型「记住数字 42」，
> 再用同目录 `--resume <id>` 问「我刚说的数字是多少」，模型答 **42**。
> 反向验证：指向自定义目录时 resume 默认目录的会话，YuShan 正确输出
> `找不到会话：<id>` 并正常退出（不静默跑新会话）。
> ⇒ §6 的会话隔离与续轮**不互斥**，可以同时要。

### 4.5 进程生命周期

完全照抄 `codex/adapter.ts:186-220` 的形态：

| 环节 | 行为 |
|---|---|
| spawn | `spawnProcess(binary, args, {cwd, env, stdio:['pipe','pipe','pipe']})` |
| stdin | **立即** `child.stdin.end()`（prompt 在 argv 里） |
| stderr | 逐行 `log.warn('agent','stderr')`，同时累积供失败诊断（截 500 字符） |
| stop | `SIGTERM` → 等 `stopGraceMs` → `SIGKILL`；置 `stopReason='interrupted'` |
| waitForExit | 同 codex，`Promise<boolean>` 带超时 |
| 终局兜底 | stdout 结束后：若已有终局事件则不发；否则按退出码补 `done`/`error` |

**宽限默认值建议 10s**（不是 codex 的 5s）。理由：实测 `SIGTERM` 后 YuShan 要等当前工具
abort（`bash` 每 100ms 轮询 `is_aborted()`，命中即杀整个进程组）并跑 `kill_backgrounds_on_exit`，
`headless-worker-contract.md` §2 称「5 秒宽限有 50× 余量」，但那是理想路径；
bridge 侧 `getAgentStopGraceMs` 默认 5000 且上限 30s（`config/schema.ts:270`），
建议在 yushan 分支单独取 `max(configured, 10_000)`。

### 4.6 退出码处理

```
exit 0   → 正常收场（RunFinished 已发 done）
exit 75  → Cancelled / NoOutput ⇒ interrupted
exit 1   → Failed ⇒ error{failed}
其它非 0 → error{failed}，附 stderr 尾部
```

**退出码是兜底，不是主路径**：主路径永远靠 `RunFinished` / `RunFailed` 事件；
退出码只在「事件流被截断」（stdout 没见到终局事件就关了）时决定终局形态。

---

## 5. `YushanTranslator` 设计（核心）

### 5.1 输入形态判别

YuShan 的 stdout 有**两种形状混在一条流里**，必须先分流：

```ts
// 会话行：顶层有 type='session' 与 id，没有 source/event
// Envelope：有 source + turn + event
if (isRecord(raw) && raw.type === 'session' && typeof raw.id === 'string') → 会话
else if (isRecord(raw) && isRecord(raw.event)) → 事件
else → 计入 drift.anomalies，丢弃
```

排序保证：会话行**恒为第一行且先于任何 Envelope**（`headless-worker-contract.md` I1）。
但 translator 不依赖顺序 —— 谁先到谁先处理，会话行只用来记 id。

### 5.2 映射表

| YuShan 事件 | 产出 | 说明 |
|---|---|---|
| `{"type":"session","id":X}` | `{type:'system', sessionId:X}` | 触发 bridge 记 catalog（§6） |
| `UserMessage` | *无* | 是 bridge 自己发的话，回显会重复 |
| `RoundStarted` | *无* | bridge 无「轮」概念 |
| `RoundUsage{purpose,round,usage}` | `{type:'usage', …}` | 字段映射见下 |
| `ModelThinkingDelta{text}` | `{type:'thinking', delta:text}` | |
| `ModelTextDelta{text}` | **累积，暂不发**（B 案） | 见 §5.3 |
| `ToolCall{call:{id,name,arguments}}` | `{type:'tool_use', id:call.id, name:call.name, input:call.arguments}` | |
| `ToolResult{id,result:{content,is_error}}` | `{type:'tool_result', id, output:result.content, isError:result.is_error}` | |
| `RunFinished{stop_reason,usage,rounds}` | `final_text`（累积正文）→ `usage` → `done` | 见 §5.4 |
| `RunFailed{error}` | `{type:'error', message:error, terminationReason:'failed'}` | |
| `ModelStreamDiscarded{reason}` | *无* | B 案下正文尚未发出，作废即清空累积缓冲 |
| 其它（`DeferredResult` / `AdviceInjected` / `ContextCompacted` / `SessionResumed` …） | *无*，计 `drift.unknownEvents` | 后续按需再接 |

`RoundUsage` 字段映射：

| YuShan `usage` | bridge |
|---|---|
| `input_tokens` | `inputTokens` |
| `output_tokens` | `outputTokens` |
| `prompt_cache_hit_tokens` | `cachedInputTokens` |
| `reasoning_tokens` | `reasoningOutputTokens` |
| （无成本信息） | `costUsd` 省略 |

### 5.3 为什么正文「攒到终局」

bridge 的 `text` 事件是**累加**语义（`card/run-state.ts:55`：
`last.content + evt.delta`）。而 YuShan 在遇到可重试的 provider 错误时会发出
`ModelStreamDiscarded` 并**用同一请求重发整次尝试**（`event.rs:100` 注释、
`crates/ys-loop/src/basic.rs` Step 7）。若已按 delta 流给 bridge，重放会让卡片上出现
**两份正文**，且无法撤回。

这正是 YuShan 自己 `-p` 模式的 `PrintBuffer` 结论（`main.rs:594` 注释原文：
「已写出的那半句无法撤回，重放会让屏幕上出现两份」）。故：

```
ModelTextDelta  → buffer.push(text)       （不给 bridge）
ModelStreamDiscarded → buffer.clear()     （作废本次尝试）
RunFinished     → {type:'final_text', content: buffer}   （只发一次）
```

代价：卡片上没有逐字流式。**这是刻意接受的** —— 飞书卡片不是终端，
而 `thinking` 与 `tool_use` 仍实时可见，用户能感知进度。

替代方案（A 案）是扩 `AgentEvent` 加 `text-reset`，但会撞
`tests/unit/agent/types-contract.test.ts` 钉死的契约，且需要同时改所有渲染方。不做。

### 5.4 `stop_reason` 映射

| `stop_reason` | 退出码 | bridge `terminationReason` | 备注 |
|---|---|---|---|
| `Completed` / `MaxRounds` / `Truncated` | 0 | `normal` | |
| `Cancelled`（预算 / SIGTERM） | 75 | `interrupted` | 实测已确认 |
| `NoOutput` | 75 | `normal` | **见下** |
| `Failed` | 1 | 走 `error{failed}` | 不发 `done` |

**`NoOutput` 的语义缝隙**：退出码 75 表示「可重试」，但它**不是中断** —— 模型只是没给出
可见内容。bridge 的 `terminationReason` 只有 `normal|interrupted|timeout`，没有「空输出」档。
处置：发 `done{normal}`，且**不发 `final_text`**（缓冲为空）。bridge 现有的
「无内容」兜底会处理空卡片（`channel.ts:1390` `finalReplyState` + `(no content)` 占位回收）。
译成 `interrupted` 是错的：会让用户看到「已中断」，而实际上回合正常跑完了。

---

## 6. 会话连续性

### 6.1 存储形状

Yushan 走 **sessionId**（不是 threadId），与 claude 同形。`SessionCatalog` 需放行：

```ts
// src/session/catalog.ts:217  归一化白名单
(raw.agentId !== 'claude' && raw.agentId !== 'codex' && raw.agentId !== 'yushan')

// src/session/catalog.ts:250  有效性判据（yushan 与 claude 同：有 sessionId、无 threadId）
if (entry.agentId === 'claude' || entry.agentId === 'yushan') {
  return Boolean(entry.sessionId) && !entry.threadId;
}

// src/session/catalog.ts:255  upsert 断言，同上两处分支
```

### 6.2 读写路径

```
YushanTranslator 收到会话行
  → {type:'system', sessionId}
    → run-flow.ts:191 的 `agentId === 'claude'` 分支扩成 `|| === 'yushan'`
      → sessionCatalog.upsertActive({agentId:'yushan', sessionId})
        → 下一轮 run-flow.ts:123 的 `agentId === 'claude'` 分支同样扩
          → opts.sessionId → adapter 拼 `--resume <id>`
```

**关键点**：yushan 完全复用 claude 的 sessionId 通路，`threadId` 恒 `undefined`。
这让 `run-flow.ts` 的两处 `if/else if` 只需加一个 `||`，不需要新分支。

### 6.3 `/resume` 历史列表

claude 的历史读取器（`src/session/history.ts`）扫 `~/.claude/projects/<encoded-cwd>/*.jsonl`，
且预览提取靠 `line.includes('"type":"user"')`。**YuShan 的会话格式不同**：

```
{"type":"meta","v":1,"title":"<任务首行>","provider":"…","model":"…","turns":1,…}
{"role":"User","content":[{"Text":{"text":"…"}}]}
{"role":"Assistant","content":[{"ToolUse":{…}}]}
```

⇒ 需要独立的 `src/session/yushan-history.ts`：

- 扫描 `join(yushanSessionsDir, '*.jsonl')`（**必须用 adapter 同一个目录**，否则列表与
  实际 resume 对不上）；
- 按 `mtime` 降序取前 `limit`；
- 预览优先取首行 meta 的 `title`（YuShan 已经算好，比重新解析正文更省），
  回退到首个 `{"role":"User"}` 的 `content[0].Text.text`；
- `lineCount` 直接数行。

**注意**：YuShan 的 session id 形如 `1794329421_023952000`（时间戳_纳秒），
不是 claude 的 `2026-10-07-abc` 语义 —— `/resume` 卡片上不该假定格式。

---

## 7. `agentKind: 'yushan'` 接入清单

`'claude' | 'codex'` 是封闭联合，实测硬编码位点：**58 处 `=== 'codex'` / `=== 'claude'` 判断
分布在 21 个文件**，另有 6 处类型定义。下表按「不改就出错」到「改了才正确」排序。

### 7.1 类型定义（6 处，必改）

| 文件:行 | 现值 |
|---|---|
| `src/config/profile-schema.ts:16` | `export type AgentKind = 'claude' \| 'codex';` |
| `src/agent/preflight.ts:3` | `export type LocalAgentId = 'claude' \| 'codex';` |
| `src/agent/capability.ts:5` | `export type AgentCapabilityId = 'claude' \| 'codex';` |
| `src/agent/capability.ts:6` | `export type AgentSessionKind = 'claude-session' \| 'codex-thread';` |
| `src/cli/agent-detection.ts:5` | `export type AgentKind = 'claude' \| 'codex';`（**重复定义**，与 schema 那份不同源） |
| `web/src/lib/types.ts:1` | `export type AgentKind = "claude" \| "codex";` |

**建议**：先抽 `export const AGENT_KINDS = ['claude','codex','yushan'] as const`，
让 `AgentKind = typeof AGENT_KINDS[number]`，并把散落的校验统一成
`AGENT_KINDS.includes(x)`。否则加第四种时同样会漏。

### 7.2 静默错误陷阱（**优先改**）

```ts
// src/ui/onboard.ts:80
const agentKind: AgentKind = fv.agentKind === 'codex' ? 'codex' : 'claude';
// src/ui/qr-register.ts:155  同一行
```

加 `'yushan'` 后这里**会把 yushan 静默变成 claude**，TypeScript 不报错（联合类型已放宽）。
必须改成显式的三路判断或 `agentKindFromString(fv.agentKind) ?? 'claude'`。

### 7.3 白名单校验（不改则 profile 被拒）

| 文件:行 | 改动 |
|---|---|
| `src/config/profile-schema.ts:251` | `if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex')` |
| `src/config/profile-store.ts:299` | `agentKindFromString` |
| `src/config/migrate-v2.ts:203` | 迁移白名单 |
| `src/runtime/locks.ts:181` | lock meta 校验 |
| `src/runtime/registry.ts:67` | registry 条目校验 |
| `src/agent/preflight.ts:282` | diagnostic 校验 |
| `src/session/catalog.ts:217` | catalog 归一化 |

### 7.4 行为分支（不改则行为错乱）

| 文件:行 | 现状 | yushan 应走 |
|---|---|---|
| `src/runtime/agent-runtime.ts:36` | `if (agentKind === 'codex')` 建 CodexAdapter，否则 ClaudeAdapter | 新增 yushan 分支 |
| `src/bot/run-flow.ts:123-133` | catalog 读：claude→sessionId，codex→threadId | **走 sessionId**（同 claude） |
| `src/bot/run-flow.ts:152` | `agentId === 'codex' ? images : undefined` | **yushan 也要收附件**，但走文本引用（§8） |
| `src/bot/run-flow.ts:191-209` | catalog 写：claude/codex 两分支 | 走 sessionId |
| `src/bot/comments.ts:246,250` | `=== 'claude'` / `=== 'codex'` 的恢复判据 | 走 sessionId |
| `src/commands/index.ts:560,656` | `/resume` 的 codex 分支 | yushan 走 claude 分支 |
| `src/commands/index.ts:618,639,702,703` | `applyResume` / 候选校验 | 走 sessionId |
| `src/commands/index.ts:765` | `runtimeAccessStatus` 的 claude 分支 | yushan 无 sandbox，应显示 `maxAccess` |
| `src/commands/index.ts:815,1131` | `/doctor` 的 capability 选择 | 加 yushanCapability |
| `src/bot/channel.ts:1172,1186,1237,1249` | 四处 `agentKind === 'codex'` | **逐个复审**：是「codex 特有」还是「非 claude」 |
| `src/agent/models.ts:46` | `supportedModels` | 见 §7.5 |
| `src/cli/commands/service.ts:607` | `agentDisplay` | 加显示名 |
| `src/cli/commands/migrate.ts:46` | `--agent` 解析 | 白名单跟随 |
| `web/src/views/OnboardWizard.tsx:135,188` | 选项与提示文案 | 加 YuShan 选项 |

### 7.5 `yushanCapability`

```ts
export function yushanCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return {
    agentId: 'yushan',
    sessionKind: 'yushan-session',
    // 复用 stdin-prefix 语义：提示词以文本前缀并入任务（实际走 argv，见 §4.3）
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    // 有原生 history（--resume 续上下文），故与 claude 同
    supportsNativeHistory: true,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
    // 无 sandbox / 权限档 ⇒ 声明满档，让 clampAccess 不制造假窄档
    permissions: { maxAccess: 'full' },
  };
}
```

`supportedModels('yushan')` 建议**只返回 `DEFAULT_MODEL` 一项**：

```ts
const YUSHAN_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随 YuShan 配置（~/.yushan/state.json）' },
];
```

理由：YuShan 的模型目录来自 provider registry（`~/.yushan/auth.json` + 内置 provider 表），
bridge 抄一份必然漂移。要给完整选择器就得让 YuShan 先有 `--list-models`，那是后续工作。
**注意**：`YUSHAN_MODEL` 环境变量确实有效（事实 3），所以只要将来往这张表里加值就能用，
不需要再改 adapter。

---

## 8. 图片附件

codex 走 `--image <path>` flag；yushan 不同。

YuShan **明确设计**为用户输入侧不解析图片路径（`docs/design-final/vision-input.md` §1 末行：
「文本里的 `/tmp/a.png` 原样留在 `Text` 块里，由模型自己决定调用 `view_image`；
全仓没有任何代码从文本中提取图片路径」）。故 bridge 只需把路径拼进 prompt：

```
<bridge_context>…</bridge_context>

## user_message

<用户原话>

## attachments

- [image: /path/to/a.png]
- [file: /path/to/b.docx]
```

模型看到 `[image: …]` 会自行调 `view_image`。**不需改 YuShan**，也符合它已有的工具面
（`view_image` 是 `tools-basic` 里的工具，带 `high` / `original` 两档）。

改动点：`src/bot/run-flow.ts:151` 的 `agentId === 'codex' ? images : undefined`
需扩展为「codex 走 flag；yushan 走文本；claude 走自有 stdin 协议」。

---

## 9. 风险与未验证项

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| **R1** | ~~`YUSHAN_SESSIONS_DIR` 指向非默认目录后，`--resume <id>` 能否找到会话~~ | — | **已验证通过（可共存）**：见 §4.4。会话隔离与续轮不互斥 |
| **R2** | `YUSHAN_MODEL` 与 `~/.yushan/state.json` 的优先级 | 可能覆盖用户在 TUI 里的选择 | `help.rs:39` 称「覆盖 env / meta / 首个有凭证者」，即以 env 为最高优先。bridge 只在 `opts.model` 非空时才设，`DEFAULT_MODEL` 时不设 ⇒ 不干扰 |
| **R3** | `NoOutput`（75）被误译 | 用户看到「已中断」但回合其实跑完了 | 已定：译 `normal` + 不发 `final_text`（§5.4） |
| **R4** | ~~`YUSHAN_DEBUG=0` 是否真的抑制全部 stderr~~ | — | **已验证**：`--json` 模式下 stderr 本来就是 0 字节（开/关该变量都一样）。保留 `YUSHAN_DEBUG=0` 作为防御（无副作用） |
| **R5** | 多 profile 并发用不同 `YUSHAN_SESSIONS_DIR` | 无共享状态问题（YuShan 会话按文件） | 低风险 |
| **R6** | `ys-coding-agent` 未安装 | `checkAvailability` 报 `agent-binary-not-found` | 沿用既有 preflight 诊断；`/status` 已有这条路径 |
| **R7** | 工具审批固定 `AutoApprove` | bridge 的 `read-only` 档无法真正只读 | 已在 capability 声明 `maxAccess:'full'`；README 需写「yushan 不支持只读档」 |

---

## 10. 实施顺序

每步独立可验证，前 3 步即可端到端跑通。

| 步 | 内容 | 验收 |
|---|---|---|
| **0** | ~~验证 R1~~ | **已完成**：自定义会话目录下 `--resume` 能延续上下文（实测答出 42）；跨目录 resume 报 `找不到会话` |
| **1** | **Y1**：YuShan 加 `--version`（~5 行 + help 一行 + 单测） | `ys-coding-agent --version` 退出 0 且输出非空 |
| **2** | **B1**：`translate.ts` + fixture 单测 | 用**录制好的** NDJSON 跑通映射表，不依赖真实模型 |
| **3** | **B2**：`adapter.ts` + `argv.ts` + prepare-run 测试 | 手工 `--agent yushan` 跑通单轮 |
| **4** | **B4**：`agentKind` 全线接入（§7 清单） | profile 能被创建、能启动、`/status` 正确 |
| **5** | **B5**：`yushan-history.ts` + `/resume` 分支 | `/resume` 能列出并恢复 |
| **6** | **B3/B6**：模型 env、图片文本 | `/config` 显示「跟随 YuShan」；带图消息能看图 |
| **7** | **Y2**：YuShan 加 `--` 终止符（可选） | `--json -- --stats` 把 `--stats` 当任务 |

第 1–3 步完成后，bridge 已经能驱动 YuShan（只是 profile 系统还没正式承认）。
第 4 步是让 `agentKind` 诚实。

---

## 11. 测试计划

| 层 | 文件 | 覆盖 |
|---|---|---|
| 翻译器 | `tests/unit/agent/yushan-translate.test.ts` | 会话行→system、文本累积、`ModelStreamDiscarded` 清空、工具对、usage 映射、四种 `stop_reason`、未知事件计数 |
| argv | `tests/unit/agent/yushan-argv.test.ts` | 顺序、`--resume` 只在有 id 时出现、`--` 开关 |
| 适配器 | `tests/unit/agent/yushan-prepare-run.test.ts` | 预检失败 → `SpawnFailed` |
| 契约 | `tests/unit/agent/capability.test.ts` | 补 `yushanCapability` 用例 |
| 迁移 | `tests/integration/config/profile-migration.test.ts` | yushan profile 归一化 |
| 会话 | `tests/integration/session/resume.test.ts` | yushan 的 sessionId 通路 |
| 历史 | `tests/unit/agent/yushan-history.test.ts` | meta 预览、按 mtime 排序、空目录 |

**fixture 来源**：直接用 §2 事实 1 的真实输出，另录一份含
`ModelStreamDiscarded` + 工具失败 + `RunFailed` 的样本。**不要**在单测里调真实模型。
