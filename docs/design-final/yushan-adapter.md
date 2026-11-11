# YuShan 适配 — 最终交付文档

> 范围：`1b047de..3136e61`（9 个提交），把 `ys-coding-agent`（YuShan）接入为 bridge 的第三种 agent。
> 上游依据：[`adr-001-yushan-as-third-agent.md`](../arch/yushan-adapter/adr-001-yushan-as-third-agent.md)、
> [`design-plans/yushan-agent-adapter.md`](../design-plans/yushan-agent-adapter.md)、
> [`exec-plans/yushan-agent-adapter.md`](../exec-plans/yushan-agent-adapter.md)

## 1. 概述

bridge 新增 `agentKind: 'yushan'` 作为与 `claude` / `codex` 并列的第三种 agent：会话沿用
`sessionId` 通路（与 claude 同形，走 `sessionCatalog`、`/resume` 与 lock），正文不逐字流式，
而是攒到终局以单条 `final_text` 交出。

## 2. 最终架构决策（ADR 摘要）

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| 1 | 是否复用 `agentKind: 'codex'` | 新增 `'yushan'`，复用被否 | `sessionCatalogKey` 以 `agentId` 为键（`src/session/catalog.ts:50`），复用会与真 codex 会话撞键；`isValidAgentEntry`（`:250`）与 `assertAgentIdentity`（`:257`）要求 codex 条目必须有 `threadId`，YuShan 没有 |
| 2 | `sessionId` 还是 `threadId` | `sessionId`，`sessionKind: 'yushan-session'` | 与 claude 的 `--resume <session_id>` 完全同构；`run-flow.ts` 的两处判断只需多一个 `||` 分支条件，不改结构；catalog 的互斥断言也不用改 |
| 3 | 正文逐字流式还是攒到终局 | 攒到终局发一条 `final_text` | bridge 的 `text` 是**累加**语义；YuShan 遇可重试 provider 错误会发 `ModelStreamDiscarded` 并重放整次尝试，已发出的半句撤不回 ⇒ 卡片上出现两份正文 |
| 4 | 图片走 `--image` flag 还是文本引用 | 文本引用 `- [image: /path]`，`attachmentTransport('yushan') === 'text-ref'` | YuShan 刻意不在输入侧解析图片，由模型自行调 `view_image`；且 prompt 已是单个 argv token，没有额外 flag 面 |
| 5 | `NoOutput` 译成什么终局 | `normal` | 退出码 75 同时表示 `Cancelled` 与 `NoOutput`，两者语义相反；译成 `interrupted` 会让用户误以为要重试，而重试只会再得一次空 |
| 6 | `permissions.maxAccess` 取 profile 值还是恒 `full` | 恒 `'full'`（`yushanCapability` 忽略入参） | YuShan 无 sandbox CLI 面、工具审批固定 `AutoApprove` ⇒ 较窄档会是**假窄档**，bridge 以为限住了、实际能写文件 |
| 7 | `--` 终止符条件传还是恒传 | 恒传 | YuShan 的 `split_leading_flags` 在首个非 flag token 处停止，prompt 恰好是 `--stats` / `--debug` / `--resume` 时会被吞成 flag |

不变式顺序：`--json [--resume <id>] -- <prompt>`（`src/agent/yushan/argv.ts`）。

## 3. 新增 / 修改的文件清单

**新增（3 个实现文件 + 1 个历史读取 + 1 个文档）**

| 文件 | 作用 |
|---|---|
| `src/agent/yushan/translate.ts` | `YushanTranslator`：NDJSON → `AgentEvent[]`，含会话行、正文缓冲、终局与退出码兜底 |
| `src/agent/yushan/argv.ts` | `buildYushanArgs` + `isSafeYushanSessionId`（id 形状校验，防被当 flag） |
| `src/agent/yushan/adapter.ts` | `YushanAdapter`：spawn、env、`SIGTERM`/`SIGKILL` 收尾、`terminationForExit` |
| `src/session/yushan-history.ts` | `listYushanHistory`：扫 `yushan-sessions/*.jsonl` 供 `/resume` 预览 |

**修改 — 类型与白名单**

| 文件 | 作用 |
|---|---|
| `src/config/profile-schema.ts` | `AGENT_KINDS = ['claude','codex','yushan']` + `isAgentKind()` 收窄 |
| `src/config/migrate-v2.ts`、`src/config/profile-store.ts` | 两处 `claude/codex` 二选一改为 `isAgentKind` |
| `src/agent/preflight.ts` | `LocalAgentId = AgentKind`，诊断守卫改 `isAgentKind` |
| `src/cli/agent-detection.ts` | 候选表加 `ys-coding-agent`（`LARK_CHANNEL_YUSHAN_BIN` 覆盖） |
| `src/cli/commands/service.ts` | agent 描述表加 `{ id: 'yushan', displayName: 'YuShan' }` |
| `web/src/lib/types.ts`、`web/src/views/OnboardWizard.tsx` | 前端 `AgentKind` 与向导选项 |

**修改 — 装配与行为**

| 文件 | 作用 |
|---|---|
| `src/runtime/agent-runtime.ts` | `createRuntimeAgent` 加 yushan 分支，装配 `YushanAdapter` |
| `src/runtime/locks.ts`、`src/runtime/registry.ts` | kind 白名单放行 yushan |
| `src/agent/capability.ts` | 新增 `yushanCapability`（`maxAccess` 恒 `full`）+ `capabilityForProfile` 单点分派 |
| `src/agent/models.ts` | `supportedModels('yushan')` 独立分支，只返回「跟随默认」 |
| `src/agent/prompt.ts` | 新增 `attachmentRefs` 参数与 `renderAttachmentRefs`，渲染 `## attachments` 块 |
| `src/bot/run-flow.ts` | yushan 读写 `sessionId`；`attachmentTransport` 三分派（`flag`/`text-ref`/`stdin`） |
| `src/bot/session-catalog-identity.ts`、`src/bot/comments.ts` | 三元式收敛为 `capabilityForProfile`；resume 判据含 yushan |
| `src/bot/channel.ts` | 6 处 `agentKind === 'codex'` 改为 `usesFinalTextState(agentKind)` |
| `src/card/run-state.ts` | 新增 `usesFinalTextState(kind) => kind !== 'claude'` |
| `src/session/catalog.ts` | `isValidAgentEntry` / `assertAgentIdentity` 把 yushan 归入 claude 侧（要求 `sessionId`、禁 `threadId`） |
| `src/commands/index.ts` | `/resume`、`/status`、`/doctor` 的 yushan 分支 + `yushanHistoryProvider` 测试缝 |
| `src/meeting/orchestrator.ts` | 会议回答兼收 `final_text`（只读 `text` 会让不流式 agent 答空） |
| `src/ui/onboard.ts`、`src/ui/qr-register.ts` | 修复**静默降级**：未知 kind 原本被三元式改写成 claude，现改为显式拒绝 |
| `README.md`、`README.zh.md` | 用户可见文档：第三种 agent + 无只读档的事实 |

## 4. 三条实测确认的关键约束

### C1 `RoundUsage` 是每轮增量 ⇒ usage 只发一次总量

实测两轮：`7814 + 7872 = 15686`，与 `RunFinished.usage.input_tokens = 15686` 相等（output 同理 `37+36=73`）。

bridge 侧 `usage` 的消费方只做 `reportMetric('tokens_in'/'tokens_out'/…)`，**不进 `RunState`**
（`grep usage src/card/run-state.ts` 为空，`src/card/run-state.ts` 整轮只新增了 `usesFinalTextState`）。
所以逐条 `RoundUsage` 发 `{type:'usage'}` 不会让卡片更准，只会让指标多次累加、**翻倍失真**。

⇒ 处置：`RoundUsage` **不产出任何事件**，`usage` 只在 `RunFinished` 发一次总量（`translate.ts`
`case 'RoundUsage': return [];`，注释指向 C1）。缺 `usage` 字段时不猜 0（`usageEvent` 四个字段
全 undefined 即返回 `undefined`）。事件顺序固定 `final_text` → `usage` → `done`。

补充（实测）：被 SIGTERM 取消的那一轮 `RunFinished{Cancelled}` 带的 usage **四个计数全为 0**——
那是「模型没做这些活」，不是「用了 0 token」；报成样本会把 profile 的 token 均值往零拉。
故全零 usage 直接丢弃（`usageEvent` 的第二个早退），不产出 `usage` 事件。

### C2 `--resume` 后会话文件被整体重写 ⇒ `/resume` 预览只能用 `title`

实测：`meta.title` 变成**最新一轮**的任务文本（不是会话主题）；`meta.turns` **不可信**
（2 个完整回合仍写 `turns:1`）；`meta.input_tokens` / `output_tokens` 是**单轮值**。

⇒ 处置（`src/session/yushan-history.ts`）：预览取 `meta.title`（经 `normalizeSessionPreview`），
`title` 缺失或为空时回退到首个 `{"role":"User"}` 的 `content[0].Text.text`，再兜底 `(空会话)`；
返回的 `SessionSummary` 只有 `{sessionId, mtime, preview, lineCount}` —— **绝不用 `turns` 推算回合数，
不展示 token 数**。`sessionId` 就是文件名去掉 `.jsonl`（形如 `1794403057_979860000`），是
**不透明 id**，不解析成日期。

### C3 `ModelTextDelta` 拼接成立，但 `ModelStreamDiscarded` 必须清空缓冲

实测 8 个 delta 拼成完整句子，故「攒到终局」可行。但 YuShan 会作废整段流后重放，
`case 'ModelStreamDiscarded': this.textBuffer = ''` 是这一步的正确性前提；`RunFailed`
与 `RunFinished` 之后也都清空，避免跨 run 残留。

## 5. 已知限制与风险

- **R7（本轮接受）**：YuShan 工具审批固定 `AutoApprove`，bridge 的 `read-only` / `workspace` 档位对
  yushan **无效**——YuShan 没有 sandbox CLI 面。`yushanCapability.permissions.maxAccess = 'full'`
  保证 `clampAccess` 不会产出假窄档。后续 YuShan 接 Seabox 后再实现只读。
- **退出码 75 有歧义**：`Cancelled` 与 `NoOutput` 共用 75，无法靠退出码区分，以 JSON 事件为准。
  `terminationForExit` 仅在 `hadTerminal === false` 时兜底（此时 75 判 `interrupted`），
  `RunFinished` / `RunFailed` 一旦到达就以事件为准。
- **`stopGraceMs` 下限被抬到 10s**（`MIN_STOP_GRACE_MS`）：配置更低不生效，SIGKILL 仍等满下限。
  原因是 SIGTERM 要让 YuShan 先中止在飞的工具调用，过早 kill 会留下半写的会话文件。
- **`/resume` 不做 cwd 过滤**：claude 的会话按项目目录分开放（`claudeProjectDir(cwd)`），yushan 只有
  **每个 profile 一个扁平目录**（`<profileStateDir>/yushan-sessions`），且会话文件不记录工作目录
  （实测 `meta.workspace` 恒为 `null`，即使在 git 仓库里跑）。所以 yushan 的 `/resume` 会列出该 profile
  下的所有会话，而不是当前 cwd 的。恢复的会话自带它当初的工具 cwd。
- **无逐字流式**：进度只能从 `thinking` 与 `tool_use` 感知（决策 3 的代价）。
- **文档义务已落地**：`README.md:39` 与 `README.zh.md` 明确写出「YuShan always runs with
  auto-approve / 不支持 read-only 档」，`README.md:232` 说明权限映射不覆盖 YuShan；
  `tests/unit/docs/readme-contract.test.ts` 新增 4 条用例守住这些句子，其中一条专门断言
  README **不得**声称 yushan 支持只读档。

## 6. 测试与验证

| 指标 | 数值 |
|---|---|
| `pnpm vitest run tests/unit tests/integration` | **792 passed**（107 文件） |
| 其中 unit / integration | 528 / 264 |
| 基线（`1b047de`，补上 `src/ui/generated` 构建产物后实测） | 666（unit 420 + integration 246） |
| 本轮净增 | 126（792 − 666） |
| `pnpm typecheck` | 零错 |

> 基线数字注意：直接 checkout `1b047de` 跑会在 3 个文件上收集失败
> （`tests/integration/ui/server.test.ts` 等依赖 `src/ui/generated/index.html`），此时显示
> 644 passed / 3 failed；补上该产物后为 666。改动前的 unit 部分恰为 **420**。

**变异验证**（每条都在临时 worktree 中实地跑过全量套件，不是推演）：

| 破坏点 | 失败测试 | 失败数 |
|---|---|---|
| `RoundUsage` 改为发 usage 事件 | `tests/unit/agent/yushan-translate.test.ts > emits usage exactly once, from the RunFinished total` | 1 |
| `usesFinalTextState` 改回 `=== 'codex'` | `tests/unit/card/run-state.test.ts` 的 2 个 N3 用例（`is true for yushan …`、`yushan must go through the finalText -> blocks promotion path`） | 2 |
| `catalog.ts` 的 yushan 分支去掉（只剩 `'claude'`） | `tests/unit/session/catalog.test.ts > stores YuShan sessions in the claude-shaped slot and isolates them from codex`（另带 3 个 integration 用例） | 4 |
| 会议 `final_text` 收集去掉 | `tests/unit/meeting/summary.test.ts > answers from a final_text-only agent (yushan emits no text deltas)` | 1 |
| 取消轮的全零 usage 过滤去掉 | `tests/unit/agent/yushan-translate.test.ts > drops an all-zero usage sample from a cancelled run` | 1 |
| `run-policy` 恢复无条件 `clampAccess` | `tests/unit/policy/run-policy.test.ts` 的 2 个「no sandbox surface」用例 | 2 |

## 7. 本轮范围外（明确不做）

- **不引入 YuShan 模型目录**：`supportedModels('yushan')` 只返回「跟随默认（不指定）」，
  模型由 `YUSHAN_MODEL` env 或 YuShan 自身 provider 配置决定，避免把 bridge 猜的 id 递过去。
- **不实现 read-only 档**（R7）。
- **不改 `AgentEvent` 契约**：没有新增 `text-reset` 之类事件，`tests/unit/agent/types-contract.test.ts` 保持原样。
- **不加 `--image` flag**：附件只以 `[image: /path]` 文本引用进入 prompt。
