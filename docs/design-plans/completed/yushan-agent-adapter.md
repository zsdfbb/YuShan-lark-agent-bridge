# YuShan 适配 — 设计计划

> 日期：2026-11-11
> 权威来源：[`docs/arch/yushan-adapter/design.md`](../arch/yushan-adapter/design.md)
> 决策记录：[`adr-001-yushan-as-third-agent.md`](../arch/yushan-adapter/adr-001-yushan-as-third-agent.md)
> 现状与约束：[`context.md`](../arch/yushan-adapter/context.md)
> 基线：bridge `5898681`（v0.7.1）／ `ys-coding-agent`（YuShan 2026-11-10 构建）
> 本文是对 `design.md` 的精炼版：保留全部实现所需决策与约束，不重复其论证过程。

---

## 1. 目标与验收判据

让 `lark-channel-bridge` 把 `ys-coding-agent`（Rust CLI，已完工）当作第三种受支持 agent，
与现有 `claude` / `codex` 并列。

消费方式沿用既有范式：**每条用户消息 spawn 一个短命进程 → 解析 stdout NDJSON → `SIGTERM` 收尾**。
两侧各自零改动：YuShan 只提供 `--json` 契约，bridge 只新增一个 adapter + 一个 translator，
中间的 `AgentEvent` 内部契约不动。

| # | 判据 | 验收形态 |
|---|---|---|
| **A1** | 首轮跑通 | 飞书发任务 → 卡片出现正文与工具过程；一次 `--json` 进程，`RunFinished` 后卡片终态为 done |
| **A2** | 续轮上下文连续 | 第二轮带 `--resume <id>`，模型能引用第一轮内容 |
| **A3** | 取消干净 | 用户点停止 → `SIGTERM` → 进程 75 退出 → 卡片终态 interrupted，无孤儿进程 |
| **A4** | 预检不误报 | profile 启动时 `checkAvailability` 返回 ok，不因 `--version` 缺失而失败 |
| **A5** | 不污染既有 agent | claude / codex 的 profile、会话、测试全部照旧 |

**非目标**（明确不做，避免范围蔓延）：

- 不改 YuShan 的 loop / 工具层 / 事件层；
- 不扩 `AgentEvent` 契约（不引入 `text-reset` 之类新事件）；
- 不实现 sandbox 三档（YuShan 无此 CLI 面，见 §14.1 R7）；
- 不做 YuShan 会话历史的富展示。

---

## 2. 三条决定设计形态的实测事实

这三条把「要改 YuShan 多少」压到了零。全部为生成期实测，非文档推测。

1. **`--json` 已是专为 bridge 设计的 headless 接口。** 一次真实运行即包含 bridge 需要的
   全部四类信息：会话 id（stdout 首行 `{"id":…,"type":"session"}`）、正文流
   （`ModelTextDelta`）、工具过程（`ToolCall` / `ToolResult`）、用量与终局
   （`RoundUsage` / `RunFinished`）。⇒ 不需要改 YuShan 事件层。
2. **`SIGTERM` 已走「abort 本回合 + 退出 75」正确路径。** 实测 stderr 为
   `SIGTERM received — aborting this turn`，stdout 尾部为 `RunFinished{stop_reason:"Cancelled"}`，
   退出码 75。⇒ A3 只差一层翻译（`Cancelled` → `interrupted`）。
3. **`YUSHAN_MODEL` / `YUSHAN_SESSIONS_DIR` 均实测生效。** ⇒ 模型选择与 per-profile
   会话隔离都不需要 YuShan 新增 CLI flag。且两者与 `--resume` **可共存**（实测：自定义
   会话目录下首轮记「42」，同目录 `--resume` 后答 42；跨目录 resume 正确报
   `找不到会话：<id>`，不静默跑新会话）。

YuShan 侧唯一曾需要的两个改动（`--version`、`--` 终止符）已由 YuShan `4962298` 落地，
**本轮剩余工作全在 bridge**。

---

## 3. 新增文件清单

| 文件 | 职责 | 行数估计 |
|---|---|---|
| `src/agent/yushan/adapter.ts` | `AgentAdapter` 实现：预检、argv/env 构造、spawn、SIGTERM + 宽限、终局兜底 | ~230（骨架抄 `codex/adapter.ts`） |
| `src/agent/yushan/translate.ts` | `YushanTranslator`：NDJSON → `AgentEvent[]`（唯一翻译边界） | ~180 |
| `src/agent/yushan/argv.ts` | `buildYushanArgs()`，纯函数便于单测 | ~40 |
| `src/session/yushan-history.ts` | 读 `<yushanSessionsDir>/*.jsonl` 供 `/resume` 列表 | ~70 |
| `tests/unit/agent/yushan-translate.test.ts` | fixture 驱动：录制 NDJSON → 断言事件序列 | ~200 |
| `tests/unit/agent/yushan-argv.test.ts` | 纯函数断言参数顺序 | ~60 |
| `tests/unit/agent/yushan-prepare-run.test.ts` | 照抄 `codex-prepare-run.test.ts`：预检失败 → `SpawnFailed` | ~80 |

**分层要点**：唯一的翻译边界在 `YushanTranslator`。它之上（`card/run-state`、`bot/cot`、
`bot/comments`、`commands`）全是既有代码零改动，它之下是 YuShan 原样输出零改动。

---

## 4. 核心设计决策摘要

| # | 决策 | 为什么（一句话） |
|---|---|---|
| **D1** | 新增 `agentKind: 'yushan'`，**不复用** `'codex'` | `codex` 这个 kind 同时承载 threadId 会话形状、GPT 模型表、`sandbox` 三档显示与 catalog 键语义，复用等于让语义撒谎渗到每个下游，且 `sessionCatalogKey` 用 agentId 做键会与真 codex 撞键、无法无损迁移 |
| **D2** | 会话走 **sessionId**，不用 threadId（复用 claude 通路） | YuShan 的 `--resume <id>` 与 claude 的 `--resume <session_id>` 完全同构，选它只需在 `run-flow.ts` 两处 `if` 里加一个 `\|\|`，选 threadId 则要动 `SessionCatalog` 的两处排他断言、收益为零 |
| **D3** | 正文**攒到终局**发 `final_text`，不逐字流（B 案） | bridge 的 `text` 是**累加**语义，而 YuShan 遇可重试 provider 错误会发 `ModelStreamDiscarded` 并用同一请求**重发整次尝试**，已发出的半句无法撤回 ⇒ 卡片上会出现两份正文 |
| **D4** | 图片走文本引用 `[image: /path]`，**不加** `--image` flag | YuShan 刻意设计为用户输入侧不解析图片路径、由模型自行调 `view_image`，加 flag 等于逆着对方架构走 |
| **D5** | `NoOutput` 译 `normal`，**不译** `interrupted` | 退出码 75 同时表示被打断与「正常跑完但没说话」，译成 `interrupted` 会让用户以为要重试，而重试只会再得一次空 |
| **D6** | `yushanCapability.permissions.maxAccess = 'full'` | YuShan 工具审批固定 `AutoApprove`，声明窄档会让 `clampAccess` 算出一个**假窄档**（bridge 以为只读、实际可写），声明 full 才让判定与真实能力一致 |
| **D7** | `--` **恒定传** | `--` 已由 YuShan `4962298` 实现，恒定传可让任何以 `-` 开头（含恰好等于 `--stats`/`--debug`/`--resume`）的任务文本逐字成为任务，无例外、无需特判 |

### 4.1 关于 D3 的代价（刻意接受）

代价是卡片上没有逐字流式。这是权衡后的选择：飞书卡片不是终端，且 `thinking` 与
`tool_use` 仍实时可见，用户能感知进度。

被否的 A 案（扩 `AgentEvent` 加 `text-reset`）会撞
`tests/unit/agent/types-contract.test.ts` 钉死的契约，还需同时改所有渲染方，不做。

### 4.2 关于 D6/D5 的取舍落点

- `maxAccess: 'full'` 的副作用是无法在 `/config` 选窄档 —— 本来也选不了，不算损失。
- `NoOutput` 发 `done{normal}` 且**不发** `final_text`（缓冲为空），靠 bridge 既有的
  「无内容」兜底（`channel.ts:1390` `finalReplyState` + `(no content)` 占位回收）处理空卡片。

---

## 5. argv 构造规则

```ts
// src/agent/yushan/argv.ts
export function buildYushanArgs(input: {
  sessionId?: string;
  prompt: string;
}): string[] {
  const args = ['--json'];
  if (input.sessionId) args.push('--resume', input.sessionId);
  args.push('--', input.prompt);
  return args;
}
```

**顺序必须严格如下**（YuShan 的 `split_leading_flags` 只认 flag 区里的三个 flag，
遇到第一个非 flag 即停）：

1. `--json` —— 子命令，必须在首位；
2. `--resume <id>` —— 可选；`id` **不能落在末尾**，否则会被当成裸 `--resume` 走交互 picker
   （实测 `--resume <id> <任务>` 能正确取 id，因为「之后还留着任务文本」）；
3. `--` —— **恒定传**；
4. `<prompt>` —— **恰好一个 token**，整段提示词（含 `<bridge_context>`）。

**约束**：

- **prompt 不走 stdin**。YuShan `main.rs:356` 明确「`-` 是读 stdin 的占位，本轮不支持」，
  任务只走 argv。但 `child.stdin.end()` **仍必须调用**，否则子进程可能等 stdin。
- argv 长度不是问题：实测 200 KB 任务文本可正常跑通。
- `-` 前缀不是问题：`--` 已覆盖所有情况。

---

## 6. env 构造规则

```ts
const env = mergeProcessEnv(process.env, {
  ...buildLarkChannelEnv(this.larkChannel),
  // 会话隔离，与 codex 的 CODEX_HOME 同思路
  YUSHAN_SESSIONS_DIR: join(this.profileStateDir, 'yushan-sessions'),
  // 模型选择：bridge 的 model 通路映射到已存在的环境变量
  ...(opts.model ? { YUSHAN_MODEL: opts.model } : {}),
  // bridge 是程序化调用方，结构化日志会污染 stderr 且无消费者
  YUSHAN_DEBUG: '0',
});
```

| 变量 | 作用 | 依据 / 注意 |
|---|---|---|
| `YUSHAN_SESSIONS_DIR` | per-profile 会话目录隔离 | 实测生效；与 `--resume` 可共存（§2 事实 3）。**`yushan-history.ts` 必须用同一个目录**，否则 `/resume` 列表与实际续轮对不上 |
| `YUSHAN_MODEL` | 把 `AgentRunOptions.model` 映射过去 | 实测生效；优先级高于 `~/.yushan/state.json`。**只在 `opts.model` 非空时才设** —— `DEFAULT_MODEL` 时不设，从而不覆盖用户在 TUI 里的选择 |
| `YUSHAN_DEBUG` | 抑制结构化日志 | 实测 `--json` 模式下 stderr 本来就是 0 字节（开/关该变量一样），保留作为**防御**，无副作用 |

---

## 7. 事件映射表（翻译器的直接依据）

### 7.1 输入形态判别（先分流，再翻译）

YuShan 的 stdout 有**两种形状混在一条流里**：

```ts
// 会话行：顶层有 type='session' 与 id，无 source/event
if (isRecord(raw) && raw.type === 'session' && typeof raw.id === 'string') → 会话
else if (isRecord(raw) && isRecord(raw.event)) → Envelope 事件
else → drift.anomalies += 1，丢弃
```

会话行恒为第一行且先于任何 Envelope（YuShan 契约 I1），但 **translator 不依赖顺序**：
谁先到谁先处理，会话行只用来记 id。

### 7.2 映射表

| YuShan 事件 | 产出 `AgentEvent` | 说明 |
|---|---|---|
| `{"type":"session","id":X}` | `{type:'system', sessionId:X}` | 触发 bridge 记 catalog（§8） |
| `UserMessage` | *无* | 是 bridge 自己发的话，回显会重复 |
| `RoundStarted` | *无* | bridge 无「轮」概念 |
| `RoundUsage{purpose,round,usage}` | `{type:'usage', …}` | 字段映射见 §7.3 |
| `ModelThinkingDelta{text}` | `{type:'thinking', delta:text}` | 实时发出 |
| `ModelTextDelta{text}` | **累积，暂不发**（B 案） | 见 §4 / §7.4 |
| `ToolCall{call:{id,name,arguments}}` | `{type:'tool_use', id:call.id, name:call.name, input:call.arguments}` | 实时发出 |
| `ToolResult{id,result:{content,is_error}}` | `{type:'tool_result', id, output:result.content, isError:result.is_error}` | 实时发出 |
| `RunFinished{stop_reason,usage,rounds}` | `{type:'final_text', content:buffer}` + `{type:'done', terminationReason}` | 见 §7.5；buffer 为空时**不发** `final_text` |
| `RunFailed{error}` | `{type:'error', message:error, terminationReason:'failed'}` | 不发 `done` |
| `ModelStreamDiscarded{reason}` | *无* | 作废本次尝试 ⇒ `buffer.clear()` |
| 其它（`DeferredResult` / `AdviceInjected` / `ContextCompacted` / `SessionResumed` …） | *无*，计 `drift.unknownEvents` | 后续按需再接 |

### 7.3 `RoundUsage` 字段映射

| YuShan `usage` | bridge |
|---|---|
| `input_tokens` | `inputTokens` |
| `output_tokens` | `outputTokens` |
| `prompt_cache_hit_tokens` | `cachedInputTokens` |
| `reasoning_tokens` | `reasoningOutputTokens` |
| （YuShan 无成本信息） | `costUsd` 省略 |

### 7.4 正文缓冲的三个动作

```
ModelTextDelta      → buffer.push(text)      （不给 bridge）
ModelStreamDiscarded→ buffer.clear()          （作废整次尝试）
RunFinished         → 发一次 final_text{content: buffer}
```

### 7.5 退出码处理（兜底，非主路径）

```
exit 0    → 正常收场（RunFinished 已发 done）
exit 75   → Cancelled ⇒ interrupted；NoOutput ⇒ normal
exit 1    → error{failed}
其它非 0  → error{failed}，附 stderr 尾部（截 500 字符）
```

**主路径永远靠 `RunFinished` / `RunFailed` 事件**；退出码只在「事件流被截断」
（stdout 没见到终局事件就关闭）时决定终局形态。

---

## 8. `stop_reason` → `terminationReason` 映射

| `stop_reason` | 退出码 | bridge `terminationReason` | 备注 |
|---|---|---|---|
| `Completed` / `MaxRounds` / `Truncated` | 0 | `normal` | 发 `final_text` + `done` |
| `Cancelled`（预算耗尽 / SIGTERM） | 75 | `interrupted` | 实测已确认 |
| `NoOutput` | 75 | `normal` | **不发** `final_text`；走 bridge「无内容」兜底（理由见 D5） |
| `Failed` | 1 | 走 `error{terminationReason:'failed'}` | **不发** `done` |

`terminationReason` 的取值受契约钉死：`done ∈ {normal, interrupted, timeout}`，
`error ∈ {failed, interrupted, timeout}`。没有「空输出」档，故 `NoOutput` 只能二选一。

---

## 9. 进程生命周期

形态完全照抄 `codex/adapter.ts:186-220`：

| 环节 | 行为 |
|---|---|
| spawn | `spawnProcess(binary, args, {cwd, env, stdio:['pipe','pipe','pipe']})` |
| stdin | **立即** `child.stdin.end()`（prompt 在 argv 里，但不能留悬挂 stdin） |
| stdout | `readline` 逐行 → `YushanTranslator` |
| stderr | 逐行 `log.warn('agent','stderr')`，同时累积供失败诊断（截 500 字符） |
| stop | `SIGTERM` → 等 `stopGraceMs` → `SIGKILL`；置 `stopReason='interrupted'` |
| waitForExit | 同 codex，`Promise<boolean>` 带超时 |
| 终局兜底 | stdout 结束后：若已有终局事件则不发；否则按退出码补 `done`/`error` |

**宽限默认 10s，而非 codex 的 5s。** 理由：实测 `SIGTERM` 后 YuShan 要等当前工具 abort
（`bash` 每 100ms 轮询 `is_aborted()`，命中即杀整个进程组）并跑 `kill_backgrounds_on_exit`。
bridge 侧 `getAgentStopGraceMs` 默认 5000、上限 30s（`config/schema.ts:270`），
故在 yushan 分支单独取 `max(configured, 10_000)`。

---

## 10. 会话连续性

### 10.1 存储形状

yushan 走 **sessionId**（与 claude 同形），`threadId` 恒 `undefined`。`SessionCatalog`
的三处需放行：

```ts
// src/session/catalog.ts:217  归一化白名单
raw.agentId !== 'claude' && raw.agentId !== 'codex' && raw.agentId !== 'yushan'
// src/session/catalog.ts:250  有效性判据（yushan 与 claude 同：有 sessionId、无 threadId）
if (entry.agentId === 'claude' || entry.agentId === 'yushan') {
  return Boolean(entry.sessionId) && !entry.threadId;
}
// src/session/catalog.ts:255  upsert 断言，同上两处分支
```

### 10.2 读写路径

```
YushanTranslator 收到会话行
  → {type:'system', sessionId}
    → run-flow.ts:191 的 `agentId === 'claude'` 分支扩成 `|| === 'yushan'`
      → sessionCatalog.upsertActive({agentId:'yushan', sessionId})
        → 下一轮 run-flow.ts:123 的同款分支同样扩
          → opts.sessionId → adapter 拼 `--resume <id>`
```

关键：完全复用 claude 通路，两处 `if/else if` 只需加 `||`，无需新分支。

### 10.3 `/resume` 历史列表

claude 的历史读取器扫 `~/.claude/projects/<encoded-cwd>/*.jsonl`，预览靠
`line.includes('"type":"user"')` —— **YuShan 的会话格式不同**：

```
{"type":"meta","v":1,"title":"<任务首行>","provider":"…","model":"…","turns":1,…}
{"role":"User","content":[{"Text":{"text":"…"}}]}
{"role":"Assistant","content":[{"ToolUse":{…}}]}
```

故需独立的 `src/session/yushan-history.ts`：

- 扫 `join(yushanSessionsDir, '*.jsonl')` —— **必须是 adapter 用的同一个目录**；
- 按 `mtime` 降序取前 `limit`；
- 预览优先取首行 meta 的 `title`（YuShan 已算好），回退到首个 `{"role":"User"}` 的
  `content[0].Text.text`；
- `lineCount` 直接数行。

**注意**：YuShan 的 session id 形如 `1794329421_023952000`（时间戳_纳秒），
不是 claude 的 `2026-10-07-abc` 语义 —— `/resume` 卡片上不该假定格式。

---

## 11. 图片附件

codex 走 `--image <path>` flag；yushan 不同。YuShan 明确设计为用户输入侧不解析图片路径
（`docs/design-final/vision-input.md` §1 末行：文本里的 `/tmp/a.png` 原样留在 `Text` 块，
由模型自行决定调 `view_image`；全仓没有任何代码从文本中提取图片路径）。

bridge 只需把路径拼进 prompt：

```
<bridge_context>…</bridge_context>

## user_message

<用户原话>

## attachments

- [image: /path/to/a.png]
- [file: /path/to/b.docx]
```

模型看到 `[image: …]` 会自行调 `view_image`（`tools-basic` 里带 `high` / `original` 两档）。
**不需改 YuShan。**

改动点：`src/bot/run-flow.ts:151` 的 `agentId === 'codex' ? images : undefined`
需扩展为「codex 走 flag；yushan 走文本引用；claude 走自有 stdin 协议」。

---

## 12. `agentKind: 'yushan'` 接入清单

`'claude' | 'codex'` 是封闭联合；实测硬编码位点 **58 处 `=== 'codex'` / `=== 'claude'`
判断，分布在 21 个文件**，另有 6 处类型定义。以下按「不改就静默出错」→「改了才正确」排序。

### 12.1 类型定义（6 处，必改）

| 文件:行 | 现值 |
|---|---|
| `src/config/profile-schema.ts:16` | `export type AgentKind = 'claude' \| 'codex';` |
| `src/agent/preflight.ts:3` | `export type LocalAgentId = 'claude' \| 'codex';` |
| `src/agent/capability.ts:5` | `export type AgentCapabilityId = 'claude' \| 'codex';` |
| `src/agent/capability.ts:6` | `export type AgentSessionKind = 'claude-session' \| 'codex-thread';`（需加 `'yushan-session'`） |
| `src/cli/agent-detection.ts:5` | `export type AgentKind = 'claude' \| 'codex';`（**重复定义**，与 schema 那份不同源） |
| `web/src/lib/types.ts:1` | `export type AgentKind = "claude" \| "codex";` |

**建议**：先抽 `export const AGENT_KINDS = ['claude','codex','yushan'] as const`，
令 `AgentKind = typeof AGENT_KINDS[number]`，并把散落的校验统一成 `AGENT_KINDS.includes(x)`。
否则加第四种时同样会漏。

### 12.2 静默错误陷阱（**最高优先级**）

```ts
// src/ui/onboard.ts:80
const agentKind: AgentKind = fv.agentKind === 'codex' ? 'codex' : 'claude';
// src/ui/qr-register.ts:155  同一行
```

加 `'yushan'` 后这里**会把 yushan 静默变成 claude**，且 TypeScript 不报错（联合已放宽）。
必须改成显式三路判断，或 `agentKindFromString(fv.agentKind) ?? 'claude'`。

### 12.3 白名单校验（不改则 profile 被直接拒绝）

| 文件:行 | 改动 |
|---|---|
| `src/config/profile-schema.ts:251` | `if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex')` |
| `src/config/profile-store.ts:299` | `agentKindFromString` |
| `src/config/migrate-v2.ts:203` | 迁移白名单 |
| `src/runtime/locks.ts:181` | lock meta 校验 |
| `src/runtime/registry.ts:67` | registry 条目校验 |
| `src/agent/preflight.ts:282` | diagnostic 校验 |
| `src/session/catalog.ts:217` | catalog 归一化 |

### 12.4 行为分支（不改则行为错乱）

| 文件:行 | 现状 | yushan 应走 |
|---|---|---|
| `src/runtime/agent-runtime.ts:36` | `if (agentKind === 'codex')` 建 CodexAdapter，否则 ClaudeAdapter | 新增 yushan 分支建 `YushanAdapter` |
| `src/bot/run-flow.ts:123-133` | catalog 读：claude→sessionId，codex→threadId | **走 sessionId**（同 claude） |
| `src/bot/run-flow.ts:152` | `agentId === 'codex' ? images : undefined` | **也要收附件**，但走文本引用（§11） |
| `src/bot/run-flow.ts:191-209` | catalog 写：claude/codex 两分支 | 走 sessionId |
| `src/bot/comments.ts:246,250` | `=== 'claude'` / `=== 'codex'` 的恢复判据 | 走 sessionId |
| `src/commands/index.ts:560,656` | `/resume` 的 codex 分支 | yushan 走 claude 分支 |
| `src/commands/index.ts:618,639,702,703` | `applyResume` / 候选校验 | 走 sessionId |
| `src/commands/index.ts:765` | `runtimeAccessStatus` 的 claude 分支 | yushan 无 sandbox，应显示 `maxAccess` |
| `src/commands/index.ts:815,1131` | `/doctor` 的 capability 选择 | 加 `yushanCapability` |
| `src/bot/channel.ts:960` | capability 三元式 | 加 yushan 分支 |
| `src/bot/comments.ts:191` | capability 三元式 | 加 yushan 分支 |
| `src/bot/session-catalog-identity.ts:25` | capability 三元式 | 加 yushan 分支 |
| `src/meeting/orchestrator.ts:299` | capability 三元式 | 加 yushan 分支 |
| `src/bot/channel.ts:1172,1186,1237,1249` | 四处 `agentKind === 'codex'` | **yushan 走 codex 分支**（见 §12.6） |
| `src/agent/models.ts:46` | `supportedModels` | 见 §12.7 / §15 N2 |
| `src/cli/commands/service.ts:607` | `agentDisplay` | 加显示名 |
| `src/cli/commands/migrate.ts:46` | `--agent` 解析 | 白名单跟随 |
| `web/src/views/OnboardWizard.tsx:135,188` | 选项与提示文案 | 加 YuShan 选项 |

### 12.5 `yushanCapability`

```ts
export function yushanCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return {
    agentId: 'yushan',
    sessionKind: 'yushan-session',
    // 复用 stdin-prefix 语义：提示词以文本前缀并入任务（实际走 argv）
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

### 12.6 `channel.ts` 四处 `=== 'codex'` 的结论：yushan **必须**走 codex 分支

Phase 1 逐个复审（L1172 / L1186 / L1237 / L1249）后的确定结论：

- yushan 按 B 案（D3）**不发 `text` 事件**，因此 `state.blocks` 里没有正文；
- 而 `renderText()`（`src/card/text-renderer.ts:18`）**只读 `state.blocks`，不读 `finalText`**；
- 只有 codex 分支经 `finalReplyState()` / `finalAnswerOnlyState()` 把 `finalText` **转成 blocks**，
  再交给 `sendFinalReply`。

⇒ 若把 yushan 归到「非 codex」一侧，卡片最终会是一片空白。故这四处判断从
`agentKind === 'codex'` 改为「`codex || yushan`」（或抽成 `usesFinalTextState(agentKind)`），
且 **yushan 必须同时保留「progress-stream 失败不抛」的容错分支**（L1186 / L1249）。

### 12.7 `supportedModels('yushan')`

只返回 `DEFAULT_MODEL` 一项：

```ts
const YUSHAN_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随 YuShan 配置（~/.yushan/state.json）' },
];
```

理由：YuShan 的模型目录来自 provider registry（`~/.yushan/auth.json` + 内置 provider 表），
bridge 抄一份必然漂移。要完整选择器需 YuShan 先有 `--list-models`，属后续工作。
因为 `YUSHAN_MODEL` 确实有效（§6），将来往这张表里加值即可生效，不必再改 adapter。

---

## 13. 测试合同

| 层 | 文件 | 验收方法 | 优先级 |
|---|---|---|---|
| 翻译器 | `tests/unit/agent/yushan-translate.test.ts` | fixture NDJSON → 断言事件序列 | 必测 |
| argv | `tests/unit/agent/yushan-argv.test.ts` | 纯函数断言顺序 | 必测 |
| 适配器 | `tests/unit/agent/yushan-prepare-run.test.ts` | 预检失败 → SpawnFailed | 必测 |
| 能力位 | `tests/unit/agent/capability.test.ts` | 补 yushan 用例 | 必测 |
| 契约 | `tests/unit/agent/types-contract.test.ts` | 既有测试须仍绿 | 必测（回归） |
| 类型 | `pnpm typecheck` | 全绿 | 必测 |
| 历史 | `tests/unit/agent/yushan-history.test.ts` | meta 预览、mtime 排序 | 必测（本轮纳入 /resume） |
| 迁移/会话 | `tests/integration/config/profile-migration.test.ts`、`tests/integration/session/resume.test.ts` | profile 归一化、resume 通路 | 可推迟 |
| A1–A5 端到端 | 真实飞书 | 需真实凭证 | MANUAL_ACK_REQUIRED |

**fixture 要求**：

- 直接用 §2 事实 1 的真实录制输出作为基线样本；
- 另录一份覆盖 `ModelStreamDiscarded` + 工具失败 + `RunFailed` 的样本；
- 翻译器用例须覆盖：会话行→system、文本累积、`ModelStreamDiscarded` 清空、
  工具对、usage 四字段映射、四种 `stop_reason`、未知事件计数；
- **不要在单测里调真实模型。**

---

## 14. 已知风险与处置

| # | 风险 | 处置 |
|---|---|---|
| R1 | ~~`YUSHAN_SESSIONS_DIR` 指向非默认目录后 `--resume` 能否找到会话~~ | **已验证通过（可共存）**：自定义目录下首轮记 42、同目录 resume 答 42；跨目录正确报 `找不到会话` |
| R2 | `YUSHAN_MODEL` 覆盖用户在 TUI 里的选择 | YuShan 以 env 为最高优先；bridge **只在 `opts.model` 非空时**才设，`DEFAULT_MODEL` 时不设 ⇒ 不干扰 |
| R3 | `NoOutput`（75）被误译 | 已定：译 `normal` + 不发 `final_text`（D5） |
| R4 | ~~`YUSHAN_DEBUG=0` 是否真能抑制 stderr~~ | **已验证**：`--json` 下 stderr 本就 0 字节；保留该变量作为防御 |
| R5 | 多 profile 并发用不同 `YUSHAN_SESSIONS_DIR` | 低风险：YuShan 会话按文件存放，无共享状态 |
| R6 | `ys-coding-agent` 未安装 | `checkAvailability` 报 `agent-binary-not-found`；沿用既有 preflight 诊断，`/status` 已有该路径 |
| **R7** | **工具审批固定 `AutoApprove`（`main.rs:1263`），bridge 的 `read-only` 档对它无效** | 见下 |

### 14.1 R7 的处置（用户已确认）

YuShan 的工具审批在树内固定为 `AutoApprove`，且没有任何 sandbox / 权限档 CLI 面。
因此 bridge 的三档（`read-only` / `workspace` / `full`）**对 yushan 只有 `full` 是诚实的**。

- **本轮接受**：不做只读隔离，也不在 bridge 里假装支持。
  `yushanCapability.permissions.maxAccess = 'full'`（D6）保证 `clampAccess` 不产出假窄档。
- **后续**：YuShan 接入 Seabox 后再实现 read-only 档，届时改 `maxAccess` 并加对应 CLI 参数。
- **文档义务**：README 必须写明「yushan 不支持只读档 / 工具审批恒为自动批准」，
  让用户在创建 profile 前就知道这个限制。

---

## 15. Phase 1 核实代码时的三个额外发现（design.md 未覆盖）

### N1：`node_modules` 原本缺失

仓库工作区没有 `node_modules`，测试根本无法运行。已执行
`pnpm install --frozen-lockfile` 解决。任何后续验证（`pnpm test` / `pnpm typecheck`）
都以此为前置条件。

### N2：`supportedModels` 不加 yushan 分支会**串到 claude 模型表**

`src/agent/models.ts:77` 的 `resolveModelArg(agentKind, value)` 内部走
`supportedModels(agentKind)`，而后者当前是：

```ts
return agentKind === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;   // src/agent/models.ts:46
```

即 **yushan 会落入 `CLAUDE_MODELS`**。后果：`claude-opus-4-8` 之类会通过
`resolveModelArg` 被当成合法值返回，再经 `YUSHAN_MODEL` 传给 YuShan —— YuShan 不认识
这个名字，行为不可预期（模型名被 provider 拒绝或静默回落）。

**修复**：在 `supportedModels` 加 yushan 分支，返回只含 `DEFAULT_MODEL` 的表
（即 §12.7 的 `YUSHAN_MODELS`）。这样 `normalizeModelSelection` 会把任何跨 agent 的
残留值归一化回 `DEFAULT_MODEL`，`resolveModelArg` 返回 `undefined`，`YUSHAN_MODEL`
不被设置。

**注意这是静默错误**：类型检查不会报，只有跑起来才暴露。它属于 §12.2 那一类，
优先级应等同。

### N3：`channel.ts` 四处 `=== 'codex'` —— yushan 必须走 codex 分支

`src/bot/channel.ts` 的 L1172 / L1186 / L1237 / L1249 四处判断已逐个核实，结论是
**yushan 必须与 codex 同侧**（不能归入 claude 侧）。

原因链：

1. yushan 按 B 案（D3）不发 `text` 事件 ⇒ `state.blocks` 里**没有正文**；
2. `renderText()`（`src/card/text-renderer.ts:18`）**只遍历 `state.blocks`，不读 `finalText`**；
3. 只有 codex 分支通过 `finalReplyState()` / `finalAnswerOnlyState()` 把 `finalText`
   转成 blocks，再走 `sendFinalReply`。

⇒ 若按「非 codex」处理，yushan 的卡片终态会是**空白**。这四处必须改成
「`codex || yushan`」（建议抽 `usesFinalTextState(agentKind)` 单点表达），
并保留随之而来的容错分支（progress-stream 抛错只记日志不重抛）。

**这条与 design.md §7.4 的「逐个复审」相比是收敛后的确定答案**，实现时不必再猜。

---

## 16. 参考落点索引

实现时最常查的既有代码：

| 用途 | 落点 |
|---|---|
| `AgentAdapter` 接口 | `src/agent/types.ts:76` |
| `AgentEvent` 契约 | `src/agent/types.ts:7` + `tests/unit/agent/types-contract.test.ts` |
| adapter 骨架（最贴近目标形态） | `src/agent/codex/adapter.ts`（preflight `:57/:73`、spawn `:108`、stop `:190`、兜底 `:246`） |
| stdout 翻译器范式 | `src/agent/codex/jsonl.ts` |
| `text` 累加语义 | `src/card/run-state.ts:55` |
| `finalText → blocks` 转换 | `src/bot/channel.ts`（codex 分支 `finalReplyState`） |
| 卡片 markdown 渲染（只读 blocks） | `src/card/text-renderer.ts:18` |
| 模型解析 | `src/agent/models.ts:46,77` |
| 能力位与 `clampAccess` | `src/agent/capability.ts`、`src/config/permissions.ts:73` |
| 停止宽限 | `config/schema.ts:270` `getAgentStopGraceMs` |
| 会话 catalog 断言 | `src/session/catalog.ts:53,217,250,255` |
| claude 历史读取器（对照） | `src/session/history.ts` |
