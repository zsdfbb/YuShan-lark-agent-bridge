# YuShan 适配 — 架构上下文

> 本目录文档：
> - **`context.md`**（本文件）—— 现状、约束、需求范围
> - [`design.md`](./design.md) —— 总体设计、映射表、接入清单
> - [`adr-001-yushan-as-third-agent.md`](./adr-001-yushan-as-third-agent.md) —— 关键决策与取舍
> - [`improvement-plan.md`](./improvement-plan.md) —— 早期清单（**部分判断已被实测推翻，仅供参考**）

## 概述

让 `YuShan-lark-agent-bridge`（TypeScript，飞书 ↔ 本地 CLI agent 桥）把 `~/Develop/YuShan`
产出的 `ys-coding-agent`（Rust）当作第三个受支持的 agent，与现有 `claude` / `codex` 并列。

## 现有架构

### bridge 侧：唯一扩展点

bridge 对 agent 的全部认知收敛在 `AgentAdapter`（`src/agent/types.ts:76`）：

```ts
interface AgentAdapter {
  readonly id: string;                 // 'claude' | 'codex'
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;      // → { runId, events, stop(), waitForExit() }
  setBotIdentity?(identity: AgentBotIdentity): void;
}
```

各次运行统一通过 `AgentRunOptions` 传参：`runId / prompt / cwd / sessionId / threadId /
model / images / sandbox / permissionMode`。

内部事件 `AgentEvent`（`src/agent/types.ts:7`）是适配层的**规范形态**，全部下游
（卡片渲染 `src/card/run-state.ts:44`、CoT `src/bot/cot.ts:355`、评论 `src/bot/comments.ts:338`、
命令 `/status` 等）只认它，不认 agent 原生协议：

`system | text | final_text | thinking | tool_use | tool_result | usage | done | error`

两处 terminal 约定：`done.terminationReason ∈ {normal, interrupted, timeout}`，
`error.terminationReason ∈ {failed, interrupted, timeout}`。

### bridge 侧：适配器实现范式（两例）

`src/agent/codex/adapter.ts` 是最贴近目标形态的范例：

| 环节 | 做法 | 落点 |
|---|---|---|
| 预检 | `checkAgentAvailability({command, binaryPath})`，默认跑 `<binary> --version`，要求退出码 0 且输出非空 | `src/agent/preflight.ts:57`、`:73` |
| 启动 | `spawnProcess(binary, argv, {cwd, env, stdio:['pipe','pipe','pipe']})` | `codex/adapter.ts:108` |
| 提示词 | **写 stdin**（`prefixBridgeSystemPrompt`），不进 argv | `codex/adapter.ts:156` |
| 系统提示注入 | 文本前缀（codex）/ `--append-system-prompt-file` 临时文件（claude） | `bridge-system-prompt.ts:143` |
| stdout 解析 | `readline` 逐行 JSON → `CodexJsonlTranslator` 产出规范事件 | `codex/jsonl.ts` |
| 停止 | `SIGTERM` → 等 `stopGraceMs`（默认 5000）→ `SIGKILL` | `codex/adapter.ts:190` |
| 终局兜底 | stdout 结束后按退出码/`stopReason` 补 `done` 或 `error` | `codex/adapter.ts:246` |

### YuShan 侧：进程可编排入口（as-built）

YuShan 已有专门为 bridge 做的 headless 契约
（`docs/design-final/headless-worker-contract.md`，一句话原文：「服务
`../YuShan-lark-agent-bridge`：每条用户消息 spawn 一个短命 `--json` 进程跑**一个回合**」）。

实测输出（`ys-coding-agent --json "<任务>"`，每行一条 NDJSON）：

```
{"id":"1794328465_333895000","type":"session"}                          ← 会话行，先于任何 Envelope
{"source":"agent","turn":1,"event":{"UserMessage":{"message":{…}}}}
{"source":"agent","turn":1,"event":{"RoundStarted":{"round":1}}}
{"source":"agent","turn":1,"event":{"RoundUsage":{"purpose":"turn","round":1,"usage":{…}}}}
{"source":"agent","turn":1,"event":{"ToolCall":{"call":{"id":"…","name":"ls","arguments":{…}}}}}
{"source":"agent","turn":1,"event":{"ToolResult":{"id":"…","result":{"content":"…","is_error":false}}}}
{"source":"agent","turn":1,"event":{"ModelThinkingDelta":{"text":"…"}}}
{"source":"agent","turn":1,"event":{"ModelTextDelta":{"text":"…"}}}
{"source":"agent","turn":1,"event":{"RunFinished":{"stop_reason":"Completed","usage":{…},"rounds":2}}}
```

关键事实：

| 事实 | 值 / 落点 |
|---|---|
| 会话行 | `{"type":"session","id":<stem>}` 恒为 stdout 第一行，仅在 `--json` 出现（`headless-worker-contract.md` I1/I2） |
| 恢复 | `--resume <id>`（裸 `--resume` 走交互 picker，headless 下不可用） |
| 会话落盘 | `~/.yushan/sessions/*.jsonl`，可用 `YUSHAN_SESSIONS_DIR` 覆盖（`apps/coding-agent/src/help.rs:43`） |
| 退出码 | `0` 有可交差输出 / `1` 不可重试失败 / `75`（`EX_TEMPFAIL`，可重试）（`main.rs:2832` `single_turn_exit_code`） |
| 终局事件 | 仅 `RunFinished` / `RunFailed`（`crates/ys-event/src/event.rs:111`、`:116`） |
| 流式回滚 | `ModelStreamDiscarded { reason }`：循环丢弃**整次**模型尝试并在同一请求上重发，已发出的半句正文作废（`event.rs:100`、`crates/ys-loop/src/basic.rs` Step 7） |
| `--version` | **不支持**。`ys-coding-agent --version` ⇒ stderr `未知参数`，退出码 1 |
| `--model` | **不支持**。无任何 per-run 模型 flag；模型由 `~/.yushan/state.json` 的 `last_active_model` 等解析 |
| 权限 / sandbox | **无 CLI 开关**。工具审批在树内固定 `AutoApprove`（`main.rs:1263`） |
| stdin 提示词 | **不支持**。`main.rs:356` 明确「单独的 `-` 视为普通参数（约定：读 stdin 的占位，本轮不支持）」；任务只走 argv |
| 用户消息里的图片路径 | 不解析。文本里的 `/tmp/a.png` 原样留在 `Text` 块，由模型自行调 `view_image`（`docs/design-final/vision-input.md` §1 末行） |
| 系统提示 | 命中 `.yushan/SYSTEM.md` 或 `~/.yushan/SYSTEM.md` 时**整体短路**（`prompt.rs:360`）；否则由 cwd 段 + 工具表 + `<project_context>` + skill 目录拼成 |
| 项目上下文 | 自动加载祖先目录的 `AGENTS.override.md` / `AGENTS.md` / `YUSHAN.md` + `~/.yushan/AGENTS.md`（`prompt.rs:329`） |
| skill | 固定扫 `<cwd>/.yushan/skills` + `~/.yushan/skills`，无环境变量 |
| 二进制 | `~/.local/bin/ys-coding-agent`（`scripts/install.sh`，不联网下载） |

### 关键数据流（目标形态）

```
飞书消息 → bot/channel.ts → run-flow.ts（policy/model/images 决策）
  → run-executor.submit → adapter.run(...)  ← 新增 YushanAdapter
    → spawn ys-coding-agent --json [--resume <id>] "<prompt>"
      → stdout NDJSON → YushanTranslator → AgentEvent
        → card/run-state.ts / bot/cot.ts 渲染
    → done{ sessionId } → session/catalog.ts 记住，下一轮 --resume
```

## 约束

- **技术**：bridge 是 ESM TypeScript（`type: module`，Node + `cross-spawn`），无原生依赖；
  YuShan 是 Rust 单二进制，edition 2024 / Rust 1.88+。二者只能靠**进程边界 + NDJSON** 通信。
- **协议**：`AgentEvent` 是内部契约，110 个测试文件中有多合同测试钉住它
  （`tests/unit/agent/types-contract.test.ts` 等）；新增 agent **不应**改变该契约。
- **`AgentKind` 是封闭联合**：`'claude' | 'codex'` 硬编码在至少 20 处
  （`config/profile-schema.ts:16`、`cli/agent-detection.ts:5`、`agent/capability.ts:7`、
  `agent/preflight.ts:3`、`session/catalog.ts:7`、`runtime/registry.ts:67`、
  `runtime/locks.ts:181`、`session/catalog.ts:217`、`agent/models.ts`、`commands/index.ts` 多处、
  `web/src/lib/types.ts:1`、`ui/onboard.ts:80`、`card/config-card.ts:8`）。
  加第三种 kind 是**跨前后端 + 配置迁移**的改动。
- **性能**：bridge 每条消息 spawn 一个进程；YuShan 冷启动要建 runtime、扫 skill、装工具表。
  单回合实测 ~2 轮（含一次工具）在数秒量级。
- **演进**：bridge 已发 npm 包（`lark-channel-bridge@0.7.1`），profile schema
  `schemaVersion: 2`；新增 kind 必须能被旧配置容忍（`normalizeProfile` 对未知 kind 抛错）。
- **组织**：两侧都是个人项目、可自由改动；YuShan 侧已有「只服务 bridge」的 as-built 契约文档，
  说明**双仓协同改动是被接受的**。

## 需求范围

### 范围内

- 新增 `YushanAdapter`，把 `ys-coding-agent --json` 的 NDJSON 翻成 `AgentEvent`。
- 会话连续性：从 session 行取 id，下一轮 `--resume <id>`；按 scope + cwd 落 `SessionCatalog`。
- `agentKind: 'yushan'` 的 profile 支持（含预检、启动、`/status`、`ps`、onboard 的最小通路）。
- 把 bridge 的 agent 指令（`BRIDGE_SYSTEM_PROMPT`，卡片回调协议等）送进 YuShan 回合，
  且不覆盖用户的 `.yushan/SYSTEM.md`。

### 范围外（明确不做的）

- 不重写 YuShan 的 TUI / loop / 工具层；不改 `ys-event` / `ys-protocol` 已有事件形态。
- 不支持 YuShan 侧 per-run sandbox / 权限档位（YuShan 无此 CLI 面）。
- 不做 YuShan 会话历史的富展示（`/resume` picker 走 YuShan 自己的 `--resume` 语义）。
- 不改 `AgentEvent` 契约本身。

### 关键场景

- 场景 1（首轮）：飞书私聊发任务 → bridge spawn `ys-coding-agent --json "<任务>"` →
  stdout 首行拿到 session id → 流式正文/工具过程进卡片 → `RunFinished` → 记 catalog。
- 场景 2（续轮）：同一 scope 再发一条 → `--resume <上一轮 id>` → 模型看到上文。
- 场景 3（取消）：用户点停止 → bridge `SIGTERM` → YuShan abort 本回合并以 75 退出 →
  bridge 报 `interrupted`（可重试语义）。
- 场景 4（图片）：bridge 收到图片附件 → 以文本引用交给 YuShan → 模型调 `view_image`。

## 阻碍落地的五个硬缺口

| # | 缺口 | 影响 | 不改进 YuShan 的绕法 |
|---|---|---|---|
| G1 | `--version` 不存在 | `preflight` 默认跑 `--version`，必然 `agent-version-check-nonzero-exit`，`prepareRun` 抛 `SpawnFailed` ⇒ 每次运行前失败 | `checkAgentAvailability` 已支持 `args` 覆盖 ⇒ 传 `['--help']`（退出码 0、首行非空）。**无需改 YuShan**，但等于用帮助首行当版本 |
| G2 | 任务只走 argv，无 stdin | bridge 的提示词含 `<bridge_context>` XML 与可能以 `-` 开头的文本；argv 有长度上限 | prompt 直接进 argv（原生二进制，不经过 `cmd.exe`，无 claude 的 `<` `>` 转义坑），需自行防 `-` 前缀 |
| G3 | 无 `--model` | 卡片里的模型选择器对 yushan 无意义，只能「跟随默认」 | profile 只出 `DEFAULT_MODEL` 一个选项 |
| G4 | 无 sandbox / 权限 flag | bridge 的 `read-only / workspace / full` 三档无法落到 YuShan，`policy.allowed` 与实际能力不一致 | 声明 `maxAccess: 'full'`，让 bridge 的 access 判定不走窄档 |
| G5 | `ModelStreamDiscarded` 无对应事件 | bridge 的 `text` 事件是**累加**的（`card/run-state.ts:55`）；重放会显示两份正文 | 只能译成 `error`（丢失「重试后成功」的正常收场）或忽略（用户看到重复半句） |

## 未澄清问题

- [x] **Q1｜允许改 YuShan 吗？** —— **已确认允许**（两侧同属一个项目方）。
      因此 G1 / G2 / G4 / G5 建议**优先改 YuShan**，而不是在 bridge 里绕：
      加 `--version`、加提示词 stdin 通道、加 per-run 模型/权限开关、给 `ModelStreamDiscarded`
      一个 bridge 可消费的规范形态。具体清单见「后续建议」。
- [ ] **Q2｜`agentKind` 怎么进？**（待用户确认）三条路：
      (a) 正式加 `'yushan'`（约 20 处 + web UI + 迁移测试）；
      (b) 复用 `'codex'` 形态、靠 `codex.binaryPath` 指向 `ys-coding-agent`（改动最小，但语义撒谎，
          `/status`、模型表、session 键形状全错）；
      (c) 先只做 adapter、走环境变量/`--agent yushan` 的临时候选。
- [ ] **Q3｜流式正文的最终形态？**（待用户确认）沿用 codex 的「边流 `text` + 终局 `final_text`」，
      还是按 `-p` 的 `PrintBuffer` 思路**攒到 `RunFinished` 一次发**？后者天然免疫 G5，代价是
      卡片上不再有逐字效果。
- [ ] **Q4｜bridge 指令怎么送达？**（待用户确认）三种：
      (a) 前缀进 argv 的任务文本（同 codex 的 `prefixBridgeSystemPrompt`）；
      (b) 写一个临时 `SYSTEM.md` 并用环境变量指向 —— **当前不存在该变量**，要改 YuShan；
      (c) 落到 workspace 的 `AGENTS.md` —— 会污染用户仓库，不推荐。
- [ ] **Q5｜退出码 75 要不要触发自动重试？**（待用户确认）bridge 目前不按退出码重试，
      只把失败报给用户。75 的语义就是「重试可能成功」，要不要在 adapter 内做一次重试？
- [ ] **Q6｜图片走哪条路？**（待用户确认）桥接层把附件路径拼进任务文本
      （`[image: /path]`）交给模型自己 `view_image`，还是要求 YuShan 加 `--image <path>`
      参数（当前用户输入侧不解析路径是**明确设计**，见 vision-input.md §1 末行）。
- [ ] **Q7｜多 cwd 与会话目录隔离？**（待用户确认）bridge 每个 profile 有独立 state 目录
      （codex 走 `CODEX_HOME`）。YuShan 只有一个 `~/.yushan`，多 profile 会把会话写在一起。
      要不要用 `YUSHAN_SESSIONS_DIR` 做 per-profile 隔离？

## 后续建议

- 实施步骤、映射表、接入清单见 [`design.md`](./design.md) §10 / §5 / §7。
- 关键取舍（为什么不复用 `codex`、为什么不逐字流）见
  [`adr-001-yushan-as-third-agent.md`](./adr-001-yushan-as-third-agent.md)。
- 建议先用录制好的 `--json` 输出做 fixture 跑通 `YushanTranslator`，不依赖真实模型调用。
- 建议在 bridge 侧补一个 `tests/unit/agent/yushan-translate.test.ts`，与 `codex-jsonl.test.ts` 同形。
