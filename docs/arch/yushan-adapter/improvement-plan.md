# YuShan 适配 — 改进清单（建议方案）

# YuShan 适配 — 改进清单（建议方案）

> ⚠️ **本文件是早期草稿，部分判断已被实测推翻。以 `design.md` + ADR-001 为准。**
>
> 差异汇总（实测后修正）：
> - **G3（无 `--model`）不是缺口** —— `YUSHAN_MODEL` 环境变量实测有效。
> - **G2 风险远小于预期** —— 只有「整个 prompt 恰好等于 `--stats`/`--debug`/`--resume`」才会炸；
>   200 KB argv 实测能跑；`--` 目前不是终止符（会被并入任务文本）。
> - **G5 不需要改 YuShan** —— bridge 侧「攒到终局发 `final_text`」解决（ADR-001 决策 3）。
> - **Y1 仍需做**；**Y2 降为建议**；**Y4 不做**。
> - `YUSHAN_SESSIONS_DIR` + `--resume` 已实测可共存（原 R1 风险解除）。
>
> 保留本文件是为了记录判断演进。

> 配套 `context.md`。本文件是**建议**，非最终设计；决策点标 ★。

## 一句话结论

**走「改 YuShan 补 3 个洞 + bridge 正式加第三种 agent」**，不做语义撒谎的复用 `codex` 方案。

理由：YuShan 侧已经有 `--json` headless 契约、`YUSHAN_MODEL` / `YUSHAN_SESSIONS_DIR` 环境变量、
退出码三档，缺的只有三处**几行就能补**的东西；而 bridge 侧的 `agentKind` 是个封闭联合类型，
绕过去（复用 `codex`）会让 `/status`、模型表、session 键形状、onboard 全部错位，后面还要还债。

## 一、YuShan 侧改动（4 项，按优先级）

### Y1｜加 `--version`（必做，约 5 行）

现状：`ys-coding-agent --version` ⇒ stderr `未知参数`，**退出码 1**（实测）。
后果：bridge 的 `checkAgentVersion` 默认跑 `--version`（`preflight.ts:73`），
必然落到 `agent-version-check-nonzero-exit`，于是 `prepareRun` 每次运行前抛
`SpawnFailed`（`codex/adapter.ts:81` 同款逻辑）。

改法：在 `parse_args` 的 flag 分支加一条，返回 `Mode::Version`，打印
`ys-coding-agent <CARGO_PKG_VERSION>` 后退出 0。`help.rs` 的「公共 flag」补一行。

绕法（不改 YuShan）：`checkAgentAvailability({args: ['--help']})`。实测 `--help` 退出 0、
stdout 首行非空、stderr 空 —— **能通**。代价是「用帮助首行当版本号」，`/status` 上显示的是
`ys-coding-agent —— 轻量、组件化的 Agent 运行时`。

★ 建议做 Y1。它是唯一一个「绕法能用但很丑」的洞。

### Y2｜提示词走 stdin 或 `--` 分隔（**建议做，但可降级**）

现状：任务只走 argv，`main.rs:356` 写明「单独的 `-` 视为普通参数（约定：读 stdin 的占位，
本轮不支持）」。实测 200 KB 的 argv 任务**能正常跑通**（macOS `ARG_MAX` 没撞上）。

真正的风险不是长度，是**首 token 以 `-` 开头**：`--json "--help 我"` 会被当成 flag
（实测 `--json "--debug"` ⇒ `Error: "--json 需要一个任务参数"`）。bridge 的提示词以
`<bridge_context>` 开头，正常不会撞；但用户消息理论上可以是任意文本 —— 不过用户消息是拼在
bridge 提示词**之后**的，所以首 token 恒为 `<bridge_context>`。实操上**不会撞**。

改法（择一，都小）：
- (a) `parse_args` 支持 `--` 作为「其后全是任务文本」的终止符（~3 行，最通用）；
- (b) `--json -` 读 stdin（~15 行，要处理 `-p` 共用路径）。

★ 建议做 (a)，只加 `--` 终止符。它比 stdin 简单，且解决了「任务文本以 `-` 开头」这个唯一
真实风险。bridge 侧对应地传 `--json -- "<prompt>"`。

### Y3｜`ModelStreamDiscarded` 的 bridge 可消费形态（★ 取决于 Q3 的选择）

现状：`ModelStreamDiscarded { reason }`（`event.rs:100`）表示「整次模型尝试作废，同一请求重发」。
bridge 的 `text` 事件是**累加**的（`card/run-state.ts:55`：`last.content + evt.delta`），
所以重放会让卡片上出现**两份正文**。

解法有两条，选一条：
- **B 案（不改 YuShan）**：adapter 在 `RunFinished` 之前**不向 bridge 发 `text`**，
  只把正文攒在内存里，终局一次性发 `final_text` + `done`。这正是 `-p` 的 `PrintBuffer` 思路
  （`main.rs:601`，注释里写明「已写出的那半句无法撤回，重放会让屏幕上出现两份」）。
  代价：卡片上没有逐字流式效果。
- **A 案（改 YuShan）**：`ModelStreamDiscarded` 也进 bridge 事件流，adapter 收到就
  发一个 `text-reset`（需扩 `AgentEvent` 契约，撞 `types-contract.test.ts` 的钉死断言）。

★ 建议 **B 案**。理由：不动 `AgentEvent` 契约（有合同测试钉住）、不动 YuShan；
「飞书卡片不是终端，逐字流式的边际价值本来就不高」，而且 bridge 对 codex 已经有
「边流 + 终局」的复杂逻辑，yushan 走「攒着发」反而更简单可靠。

如果将来想要流式，再做 A 案（那时扩契约是明确需求，不是为兼容而扩）。

### Y4｜（可选，低优先）per-run 权限 / sandbox

现状：YuShan 工具审批固定 `AutoApprove`（`main.rs:1263`），无 CLI 面。
bridge 有三档 `read-only / workspace / full`。

★ 建议**本轮不做**。而是让 `yushanCapability` 声明 `permissions.maxAccess = 'full'`，
使 `clampAccess` 不会把用户选窄档时的期望与实际能力搞混（实际能力就是 full）。
在 README 里写清「yushan 不支持只读档」。

## 二、bridge 侧改动（按依赖顺序）

### B1｜`YushanTranslator`：NDJSON → `AgentEvent`（核心，必做）

新文件 `src/agent/yushan/translate.ts`，与 `codex/jsonl.ts` 同形（class + `translate(raw)` +
`terminalEmitted()`）。

映射表（**基于实测输出**，不是猜的）：

| YuShan `event` | → `AgentEvent` | 备注 |
|---|---|---|
| `{"type":"session","id":X}`（**顶层，无 source/event**） | `{ type:'system', sessionId:X }` | 全流**第一行**；已实测 |
| `UserMessage` | *丢弃* | 是 bridge 自己发的那句话，回显会造成重复 |
| `RoundStarted` | *丢弃* | bridge 无对应概念 |
| `RoundUsage` | `{ type:'usage', inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens }` | `usage.prompt_cache_hit_tokens → cachedInputTokens`、`usage.reasoning_tokens → reasoningOutputTokens` |
| `ModelThinkingDelta.text` | `{ type:'thinking', delta:text }` | 已实测有输出 |
| `ModelTextDelta.text` | B 案：累积，不发；A 案：`{type:'text',delta}` | 见 Y3 |
| `ToolCall.call.{id,name,arguments}` | `{ type:'tool_use', id, name, input:arguments }` | 已实测，`ls` / `arguments:{path:"."}` |
| `ToolResult.{id,result:{content,is_error}}` | `{ type:'tool_result', id, output:content, isError:is_error }` | 已实测 |
| `RunFinished.{stop_reason,usage,rounds}` | B 案：先发 `final_text`（累积正文）+ 终局 `usage`，再 `{type:'done', sessionId, terminationReason}` | `stop_reason` 映射见下 |
| `RunFailed.{error}` | `{ type:'error', message:error, terminationReason:'failed' }` | |
| `ModelStreamDiscarded` | *丢弃*（B 案下无害：正文还没发过） | |
| 其余（`DeferredResult` / `AdviceInjected` / `ContextCompacted` …） | *丢弃* | 后续按需再接 |

`stop_reason` → `terminationReason`：

| `stop_reason` | bridge `terminationReason` | 退出码 |
|---|---|---|
| `Completed` / `MaxRounds` / `Truncated` | `normal` | 0 |
| `Cancelled`（预算/SIGTERM） | `interrupted` | 75 |
| `NoOutput` | `normal`（正文为空，`final_text` 不发） | 75 |
| `Failed` | `failed`（走 `error` 事件） | 1 |

★ 注意 `NoOutput`（退出码 75 但**不是**中断）：bridge 的 `terminationReason` 只有
`normal | interrupted | timeout` 三个值，没有「空输出」这个档。建议按 `normal` 发
`done` + 不发明 `final_text`，由 bridge 现有的「无内容」兜底逻辑处理
（`channel.ts:1390` `finalReplyState` 已有这条路径）。

### B2｜`YushanAdapter`：进程适配（必做）

新文件 `src/agent/yushan/adapter.ts`，**从 `codex/adapter.ts` 复制骨架**（295 行，
其中 event-stream / stop / waitForExit 三块几乎可直接搬）：

- `checkAvailability`：`args: ['--help']`（Y1 做了则去掉 args）。
- `run`：`spawn(binary, ['--json', ...(sessionId ? ['--resume', sessionId] : []), `--`?, prompt], {cwd, env})`。
  **注意**：任务走 argv（Y2 后加 `--`），**不走 stdin**；`child.stdin.end()` 要调（否则子进程可能等 stdin）。
- env：`buildLarkChannelEnv(larkChannel)` + `YUSHAN_SESSIONS_DIR`（见 B5）+ `YUSHAN_MODEL`（见 B3）+ `YUSHAN_DEBUG=0`。
- `stop`：`SIGTERM` → 等 `stopGraceMs`（**建议默认 10s**，YuShan 收 SIGTERM 要收净后台进程组）→ `SIGKILL`。
- 终局兜底：按退出码补 `done` / `error`（`0→normal`、`75→interrupted`、`1→failed`）。

### B3｜模型选择：用 `YUSHAN_MODEL` 环境变量（必做，零 YuShan 改动）

`AgentRunOptions.model` 已有通路（`run-flow.ts:147` `resolveModelArg`）。adapter 把它塞进
`env.YUSHAN_MODEL` 即可 —— **实测有效**。因此 G3 不是缺口，不需要 YuShan 加 `--model`。

`supportedModels('yushan')` 建议先只返回 `DEFAULT_MODEL` 一项（「跟随 YuShan 自己的
`~/.yushan/state.json`」），因为 YuShan 的模型目录来自 provider registry，bridge 抄一份必然漂移。
将来若要枚举，再让 YuShan 加 `--list-models`。

### B4｜`agentKind: 'yushan'` 接入（改动面最大，必须做）

已实测的**硬编码位点**（`=== 'codex' / !== 'codex' / === 'claude'` 共 58 处、21 个文件；
封闭类型定义 6 处）：

必改（不加则 yushan profile 直接被拒或行为错乱）：

| 文件 | 改动 |
|---|---|
| `src/config/profile-schema.ts:16` | `AgentKind = 'claude' \| 'codex' \| 'yushan'` |
| `src/config/profile-schema.ts:251` | `normalizeProfile` 的 kind 校验 |
| `src/agent/preflight.ts:3` + `:282` | `LocalAgentId` 联合 + diagnostic 校验 |
| `src/agent/capability.ts:5,6` | `AgentCapabilityId` / `AgentSessionKind` 加 `'yushan-session'` |
| `src/agent/capability.ts` | 新增 `yushanCapability()`：`sessionKind:'yushan-session'`、`promptInjection:'stdin-prefix'`（复用 codex 的语义：前缀进任务文本）、`supportsNativeHistory:false` |
| `src/cli/agent-detection.ts:5` | `AgentKind` 联合 + 检测 `ys-coding-agent` 的 PATH 查找 |
| `src/config/profile-store.ts:299` | `agentKindFromString` 加分支 |
| `src/session/catalog.ts:217,250,255` | catalog 归一化 + `isValidAgentEntry` / `assertAgentIdentity`（**yushan 用 sessionId，不用 threadId**，与 claude 同形） |
| `src/runtime/locks.ts:181`、`src/runtime/registry.ts:67` | lock/registry meta 校验 |
| `src/runtime/agent-runtime.ts:36` | `createRuntimeAgent` 加分支 |
| `src/bot/run-flow.ts:123-133, 191-209` | catalog 读写：yushan 按 claude 的 sessionId 路径走 |
| `src/bot/session-catalog-identity.ts:49` | `agentId: capability.agentId` 自动跟随 |
| `src/agent/models.ts` | `supportedModels('yushan')` + 全部 `=== 'codex'` 三元 |
| `src/bot/channel.ts:1172,1186,1237,1249` | 四处 `agentKind === 'codex'` 的条件要复审（是「codex 特有」还是「非 claude」） |
| `src/commands/index.ts` 多处（560/618/639/649/656/702/703/765/815/1131/1305） | `/status`、`/resume`、`/config` 的 kind 分支 |
| `src/cli/commands/service.ts:607` | `agentDisplay` |
| `src/cli/commands/migrate.ts:46` | `--agent` 解析 |
| `web/src/lib/types.ts:1` + `web/src/views/OnboardWizard.tsx:135,188` | 前端联合 + 选择项 + 提示文案 |
| `src/ui/onboard.ts:80`、`src/ui/qr-register.ts:155` | `fv.agentKind === 'codex' ? 'codex' : 'claude'` 这个三元**会静默把 yushan 变成 claude**，必须先改 |

省事技巧：`agentKindFromString`、`normalizeProfile`、lock/registry/catalog 的校验都是
「白名单」形状，建议**抽一个 `AGENT_KINDS` 常量数组**统一判，避免下次加第四种时又漏。

测试：`tests/unit/agent/capability.test.ts`、`tests/integration/runtime/registry.test.ts`、
`tests/integration/session/resume.test.ts` 等需要补 yushan 用例。

### B5｜per-profile 会话隔离（建议做，一行）

`YUSHAN_SESSIONS_DIR` 实测有效（`YUSHAN_SESSIONS_DIR=/tmp/x ys-coding-agent --json …`
⇒ 会话落到 `/tmp/x/*.jsonl`）。adapter 里设成
`join(profileStateDir, 'yushan-sessions')`，与 codex 的 `CODEX_HOME` 同思路。
不做的话多 profile 会把会话写进同一个 `~/.yushan/sessions/`。

### B6｜图片：拼进任务文本，交给模型自己 `view_image`（建议做，零改动）

YuShan **明确设计**为用户输入侧不解析图片路径（`vision-input.md` §1 末行：
「文本里的 `/tmp/a.png` 原样留在 `Text` 块里，由模型自己决定调用 `view_image`」）。
所以 bridge 只要把附件路径以 `[image: /path]` 拼进 prompt，模型会自己调 `view_image`。

这与 codex 现有做法不同（codex 走 `--image` flag），所以 `run-flow.ts:151` 那个
`agentId === 'codex' ? images : undefined` 要改成「codex 走 flag，yushan 走文本」。

## 三、执行顺序（每步可独立验证）

1. **Y1**（YuShan 加 `--version`）—— 5 行，做完 bridge 预检就能通
2. **B1** `YushanTranslator` + `tests/unit/agent/yushan-jsonl.test.ts`（用录制的 NDJSON 当 fixture）
3. **B2** `YushanAdapter` + `yushan-prepare-run.test.ts`（照抄 `codex-prepare-run.test.ts`）
4. **B4** `agentKind` 全线接入（最大的一块，按上表逐文件改）
5. **B5** 会话隔离、**B3** 模型 env、**B6** 图片文本
6. **Y2**（`--` 终止符）—— 锦上添花，可最后做

前 3 步做完就能端到端跑通单轮 + 续轮，第 4 步只是让 profile 系统正式承认它。

## 四、仍待你决定（★）

| # | 决策点 | 我的建议 |
|---|---|---|
| ★1 | Y1 改 YuShan 加 `--version`，还是 bridge 用 `['--help']` 绕？ | **改 YuShan** |
| ★2 | Y3「攒着发」B 案 vs「扩契约流式」A 案 | **B 案**（cards 不需要逐字流） |
| ★3 | `agentKind` 正式加 vs 复用 `codex` 的 `binaryPath` | **正式加**（复用会让 6 个类型 + 58 处判断全部错位） |
| ★4 | 本轮要不要碰 Y4 权限档 | **不碰**，声明 `maxAccess:'full'` |
| ★5 | 退出码 75 要不要 adapter 内自动重试一次 | **不重试**，把 75 译成 `interrupted` 让 bridge 现有逻辑处理 |
| ★6 | 图片走文本引用 vs 让 YuShan 加 `--image` | **文本引用**（符合 YuShan 明确设计） |

## 五、不做什么

- 不改 `AgentEvent` 契约（`types-contract.test.ts` 钉死）。
- 不改 YuShan 的 loop / tool / event 层。
- 不实现 YuShan 的 sandbox 三档。
- 不做 YuShan 会话历史的富展示（`/resume` 走 YuShan 自己的 `--resume`）。
