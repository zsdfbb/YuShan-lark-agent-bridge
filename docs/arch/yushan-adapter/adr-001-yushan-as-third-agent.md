# ADR-001（yushan-adapter）：YuShan 作为第三种受支持 agent

- **状态**：proposed
- **日期**：2026-11-11
- **相关**：YuShan 侧 `docs/arch/headless-worker-api/adr-001-headless-worker-contract.md`（本 ADR 消费其契约）
- **上下文**：[`context.md`](./context.md)
- **设计**：[`design.md`](./design.md)

## 背景

`lark-channel-bridge` 目前支持两种本地 CLI agent（`claude` / `codex`），扩展点收敛在
`AgentAdapter`（`src/agent/types.ts:76`）。现在要把本地 Rust agent `ys-coding-agent`
接入为第三种。

两侧都是同一开发者的项目，可自由改动。YuShan 已有专为 bridge 做的 headless 契约
（`--json` NDJSON + 会话首行 + 退出码 0/1/75 + `SIGTERM` 协作取消），实测确认可用。

## 决策

### 决策 1：正式新增 `agentKind: 'yushan'`，不复用 `'codex'`

**被否方案**：复用 `agentKind:'codex'`，把 `codex.binaryPath` 指向 `ys-coding-agent`，
再在 adapter 层做分支。改动量最小（无需动 21 个文件）。

**否决理由**：

1. **语义撒谎会渗到每个下游**。`codex` 这个 kind 承载的不只是「用哪个适配器」，
   还有：session 用 `threadId` 而非 `sessionId`（`session/catalog.ts:250` 的
   `isValidAgentEntry` 会**拒绝**没有 threadId 的条目）、模型表是 GPT 系列
   （`models.ts:37`）、`/status` 显示 `sandbox: default/max` 三档
   （`commands/index.ts:765`）。这些全部与实际不符，且每一处都需要打补丁 ——
   补丁数很快就超过老老实实加一个 kind。
2. **`sessionCatalogKey` 用 agentId 做键**（`session/catalog.ts:53`）。复用 kind 会让
   yushan 的会话与真正的 codex 会话**撞键**，切换 profile 时行为不可预测。
3. **可逆性**。正式 kind 是加法；语义复用是欠债，且一旦用户建了这类 profile 就无法
   无损迁移（配置里写着 `codex`，真实语义是 yushan）。

**代价**：需触碰 21 个文件、58 处判断。已逐个列在 `design.md` §7，其中两处
（`ui/onboard.ts:80`、`ui/qr-register.ts:155`）是**静默错误**，必须优先改。

**缓解**：先抽 `AGENT_KINDS` 常量数组统一判，避免下次加第四种再漏。

### 决策 2：会话用 `sessionId`，不用 `threadId`

`AgentCapability` 有两种 session 形状：claude 的 `claude-session`（`sessionId`）与
codex 的 `codex-thread`（`threadId`）。YuShan 的会话 id 是 `--json` 首行的
`{"type":"session","id":"<stem>"}`，语义与 claude 的 `--resume <session_id>` 完全同构。

**理由**：选 `sessionId` 让 `run-flow.ts` 的两处 `if/else if` 只需加一个 `||`
（`agentId === 'claude' || agentId === 'yushan'`），而不需要新增分支。
选 `threadId` 则要动 `SessionCatalog` 的 `isValidAgentEntry` / `assertAgentIdentity`
两处排他断言（它们规定 threadId 与 sessionId **互斥**），收益为零。

### 决策 3：正文「攒到终局」发 `final_text`，不逐字流

**被否方案**：按 `ModelTextDelta` 逐条发 `text`，与 codex 一致。

**否决理由**：bridge 的 `text` 是**累加**语义（`card/run-state.ts:55`）。YuShan 遇到可重试
provider 错误会发 `ModelStreamDiscarded` 并**用同一请求重发整次尝试**；已发给 bridge 的半句
无法撤回，重放后卡片上出现**两份正文**。这正是 YuShan 自己 `-p` 模式采用 `PrintBuffer`
的理由（`main.rs:594` 注释：「已写出的那半句无法撤回，重放会让屏幕上出现两份」）。

**替代方案与否决**：扩 `AgentEvent` 加 `text-reset` 事件。否决理由：
`tests/unit/agent/types-contract.test.ts` 用正则钉死了契约形状，扩契约要同时改所有渲染方
（`card/run-state.ts`、`bot/cot.ts`、`bot/comments.ts`），而收益仅是「卡片上有逐字效果」——
飞书卡片不是终端。

**代价**：无逐字流式。**缓解**：`thinking` 与 `tool_use` 仍实时可见，用户能感知进度。

### 决策 4：图片走文本引用，不加 `--image` flag

YuShan 明确设计为用户输入侧不解析图片路径（`docs/design-final/vision-input.md` §1 末行），
由模型自行决定调用 `view_image`。故 bridge 把附件路径以 `[image: /path]` 拼进 prompt 即可。

**理由**：这是 YuShan 的**刻意设计**（不是缺失），改它等于逆着对方的架构。
且 `view_image` 已带 `high`/`original` 档位，模型能自己选。

### 决策 5：`NoOutput` 译成 `normal`，不译成 `interrupted`

YuShan 退出码 75 同时表示 `Cancelled` 与 `NoOutput`。但两者语义相反：
前者是**被打断**，后者是**正常跑完但模型没说话**。

bridge 的 `terminationReason` 没有「空输出」档，只能二选一。选 `normal` 的理由：
译成 `interrupted` 会让用户看到「已中断」而误以为要重试，实际重试也只会再得一次空；
而 `done{normal}` + 不发 `final_text` 会落到 bridge 现有的「无内容」兜底
（`channel.ts:1390` `finalReplyState`），那张卡片会被正确回收，用户看到的是
「这次没说什么」，符合事实。

### 决策 6：`yushanCapability.permissions.maxAccess = 'full'`

YuShan 工具审批固定 `AutoApprove`（`main.rs:1263`），没有 sandbox / 权限档 CLI 面。

若声明较窄的 `maxAccess`，`clampAccess`（`config/permissions.ts:73`）会算出一个
**假窄档** —— bridge 认为运行被限制在只读，实际 YuShan 能写文件。声明 `full` 让
bridge 的判定与真实能力一致，代价是用户无法在 `/config` 里选窄档（本来也选不了）。

**后续**：若 YuShan 加了 sandbox 开关，再改这里并加对应 CLI 参数。

### 决策 7：YuShan 侧只补 `--version`（并建议 `--`）

上一版清单列了四个「必须改 YuShan」的缺口。实测后收窄为**一个必做 + 一个建议**：

| 原判断 | 实测结论 | 修正 |
|---|---|---|
| G1 缺 `--version` 必须补 | `--version` 退出 1；`--help` 退出 0 且首行非空 | **保留必做**：绕法能用但 `/status` 会把标题当版本号 |
| G2 缺 stdin / `--` 必须补 | `--` 当前被并入任务；200 KB argv 能跑；只有**整个 prompt 恰好等于** `--stats`/`--debug`/`--resume` 才炸 | **降为建议**：bridge 的 prompt 恒以 `<bridge_context>` 开头，实操不会撞 |
| G3 缺 `--model` 必须补 | `YUSHAN_MODEL` 环境变量有效 | **撤销**：不是缺口 |
| G4 缺 sandbox 必须补 | YuShan 无此 CLI 面且是刻意设计 | **本轮不做**（见决策 6） |
| G5 `ModelStreamDiscarded` 无对应 | — | **bridge 侧解决**（见决策 3） |

## Consequences

**正面**：

- YuShan 侧只需 ~5 行（`--version`）+ 可选 ~3 行（`--`），其余全在 bridge。
- 翻译边界单一（`YushanTranslator`），之上之下都是零改动，`AgentEvent` 契约不动。
- yushan 完全复用 claude 的 sessionId 通路，`/resume`、catalog、lock 都跟着走。

**负面 / 需接受**：

- 触碰 21 个文件、58 处 kind 判断，是本仓近年最大的一次「加一种枚举值」改动。
  缓解：抽 `AGENT_KINDS` 常量。
- 卡片无逐字流式（决策 3）。
- `/config` 的模型选择器只有「跟随 YuShan 配置」一项（bridge 抄不了 YuShan 的 provider 目录）。
- 无法在 `/config` 选只读档（决策 6）。

**遗留（已在生成期验证解除）**：

- **R1** ✅ **已验证**：`YUSHAN_SESSIONS_DIR` 与 `--resume` 可以共存。在自定义会话目录下
  首轮让模型「记住数字 42」，同目录 `--resume <id>` 后模型答 **42**；反向也正确
  （指向自定义目录时 resume 默认目录会话 ⇒ 输出 `找不到会话：<id>`，不静默跑新会话）。
  ⇒ 无需在「会话隔离」与「续轮」之间二选一。
