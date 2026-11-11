# YuShan 适配 — 执行计划

> 日期：2026-11-11
> 设计计划：[`docs/design-plans/yushan-agent-adapter.md`](../design-plans/yushan-agent-adapter.md)
> 权威设计：[`docs/arch/yushan-adapter/design.md`](../arch/yushan-adapter/design.md)
> 决策记录：[`adr-001-yushan-as-third-agent.md`](../arch/yushan-adapter/adr-001-yushan-as-third-agent.md)
> 基线：bridge `5898681`（v0.7.1）／ `ys-coding-agent`（YuShan 2026-11-10 构建）

## 前置条件

- **N1：依赖已安装。** 仓库原本缺 `node_modules`，orchestrator 已执行
  `pnpm install --frozen-lockfile`。后续一切验证（`pnpm vitest` / `pnpm typecheck`）以此为前置。
- **测试数据一律内联构造**，遵循既有惯例（`tests/unit/agent/codex-jsonl.test.ts` 就是内联对象，
  不是读文件）。**不要新建 `tests/fixtures/` 目录** —— 此前误建的那份已删除，不要再建。
  真实录制样本（17 行 NDJSON）直接作为内联常量粘贴进测试文件。
- 验证命令：
  ```bash
  pnpm vitest run tests/unit/agent/yushan-translate.test.ts   # 单个测试文件
  pnpm vitest run tests/unit --passWithNoTests                # 全部单测
  pnpm typecheck                                              # tsc --noEmit
  ```

## 本轮纳入范围

| 组 | 内容 |
|---|---|
| B1 | 翻译器 `translate.ts`：NDJSON → `AgentEvent[]` |
| B2 | 适配器 `argv.ts` + `adapter.ts` |
| B4 | `agentKind: 'yushan'` 全线接入（类型 / 陷阱 / 白名单 / 行为分支 / capability） |
| B5 | 会话历史 `yushan-history.ts`（供 `/resume`） |
| B3/B6 | 模型 env 通路 + 图片文本引用 |
| N2 | `supportedModels('yushan')` 分支（防串到 claude 模型表） |
| N3 | `channel.ts` 四处判断语义收敛为「非 claude」 |

## 三条实测确认的翻译器约束（必须照做）

### C1：`RoundUsage` 是每轮增量，`RunFinished.usage` 是总量 ⇒ usage 只能发一次

真实录制（`ys-coding-agent --json -- "用 ls 看一下当前目录，然后一句话总结"`，17 行）：

| 事件 | input | output | cache |
|---|---|---|---|
| round1 `RoundUsage` | 7814 | 37 | 0 |
| round2 `RoundUsage` | 7872 | 36 | 7808 |
| **各轮求和** | **15686** | **73** | 7808 |
| **`RunFinished.usage`** | **15686** | **73** | 7808 |

求和恰好等于 `RunFinished` 的总量。而 bridge 侧的 usage 消费方是
`src/bot/channel.ts:1617`：它只做 `log.info('agent','usage',…)` 与
`reportMetric('tokens_in'/'tokens_out'/'cost_usd',…)`，**不进 `RunState`、不参与卡片渲染**
（`grep usage src/card/run-state.ts` 为空）。

⇒ 若逐条 `RoundUsage` 都发 `{type:'usage'}`，`reportMetric` 会记录多次独立 metric，
而总量已含在 `RunFinished` 里，**指标翻倍失真**。

⇒ 处置：`RoundUsage` **不发** usage 事件（仅内部记账），只在 `RunFinished` 发一次（用总量）。
这是独立任务 **T5 / T6**，必须有一条断言：喂入 2 个 `RoundUsage` + 1 个 `RunFinished`，
产出的 `usage` 事件**恰好 1 个**且值等于总量。

### C2：`ModelTextDelta` 累积成立

8 个 delta 拼接结果 = 完整句子
``当前目录只有两个文件：`fixture-normal.err` 和 `fixture-normal.ndjson`，看起来像是一组测试夹具（fixture）输出。``
⇒ B 案（攒到终局发 `final_text`）可行。

### C3：真实 NDJSON 形状（内联进测试用）

```jsonl
{"id":"1794402820_061076000","type":"session"}
{"source":"agent","turn":1,"event":{"UserMessage":{"message":{"role":"User","content":[{"Text":{"text":"…"}}]}}}}
{"source":"agent","turn":1,"event":{"RoundStarted":{"round":1}}}
{"source":"agent","turn":1,"event":{"RoundUsage":{"purpose":"turn","round":1,"usage":{"input_tokens":7814,"output_tokens":37,"prompt_cache_hit_tokens":0,"reasoning_tokens":0}}}}
{"source":"agent","turn":1,"event":{"ToolCall":{"call":{"id":"call_eb32…","name":"ls","arguments":{"path":"."}}}}}
{"source":"agent","turn":1,"event":{"ToolResult":{"id":"call_eb32…","result":{"content":"…","is_error":false}}}}
{"source":"agent","turn":1,"event":{"RoundStarted":{"round":2}}}
{"source":"agent","turn":1,"event":{"ModelTextDelta":{"text":"当前目录只有两个文件："}}}
{"source":"agent","turn":1,"event":{"RoundUsage":{"purpose":"turn","round":2,"usage":{"input_tokens":7872,"output_tokens":36,"prompt_cache_hit_tokens":7808,"reasoning_tokens":0}}}}
{"source":"agent","turn":1,"event":{"RunFinished":{"stop_reason":"Completed","usage":{"input_tokens":15686,"output_tokens":73,"prompt_cache_hit_tokens":7808,"reasoning_tokens":0},"rounds":2}}}
```

形态判别：`raw.type === 'session' && typeof raw.id === 'string'` → 会话行；
`isRecord(raw.event)` → Envelope 事件；其余计 `drift.anomalies`。

## 已知风险 R7（本轮接受，需文档义务）

YuShan 工具审批固定 `AutoApprove`，无 sandbox 三档 CLI 面 ⇒ 只有 `full` 档是诚实的。
`yushanCapability.permissions.maxAccess = 'full'` 保证 `clampAccess` 不产出假窄档。
README 需写明「yushan 不支持只读档 / 工具审批恒为自动批准」—— 由 T35 落地。

---

## 任务总览表

| ID | type | 标题 | 依赖 | 涉及文件数 |
|---|---|---|---|---|
| T1 | impl | 翻译器骨架：会话行、文本累积、工具对 | 无 | 1 |
| T2 | test | 翻译器基础映射断言 | T1 | 1 |
| T3 | impl | 翻译器终局：`RunFinished` / `RunFailed` / 退出码兜底 | T1 | 1 |
| T4 | test | 终局四形态与兜底幂等断言 | T3 | 1 |
| T5 | impl | 翻译器 usage 去重（只发总量） | T3 | 1 |
| T6 | test | usage 恰好发一次且为总量 | T5 | 1 |
| T7 | impl | `buildYushanArgs` 纯函数 | 无 | 1 |
| T8 | test | argv 顺序与 `--` 终止符断言 | T7 | 1 |
| T9 | impl | `YushanAdapter` 实现 | T3, T5, T7 | 1 |
| T10 | test | 适配器预检与环境注入断言 | T9 | 1 |
| T11 | impl | `agentKind` 类型 6 处 + `AGENT_KINDS` 单一来源 | 无 | 5 |
| T12 | test | `AGENT_KINDS` 与 profile 白名单断言 | T11, T13 | 1 |
| T13 | impl | profile 侧白名单放行 yushan | T11 | 3 |
| T14 | test | 迁移与 profile-store 白名单断言 | T13 | 1 |
| T15 | impl | 运行时白名单 + catalog 身份语义放行 yushan | T11 | 4 |
| T16 | test | catalog / locks / registry / preflight 放行 yushan | T15 | 2 |
| T17 | impl | `yushanCapability` + capability 分派收敛 | T11 | 5 |
| T18 | test | `yushanCapability` 契约断言 | T17 | 1 |
| T19 | impl | `supportedModels('yushan')` 分支（N2） | T11 | 1 |
| T20 | test | yushan 模型表仅含 `DEFAULT_MODEL` | T19 | 1 |
| T21 | impl | 运行时装配 + 静默陷阱 2 处 + 显示名 | T11, T9 | 4 |
| T22 | test | onboard / qr-register 不把 yushan 静默变成 claude | T21 | 1 |
| T23 | impl | `run-flow` 会话读写走 sessionId + 附件分流 | T15, T17 | 1 |
| T24 | test | yushan 走 sessionId 通路、续轮可 resume | T23 | 1 |
| T25 | impl | `commands/index.ts` `/resume` `/status` `/doctor` 分支 | T15, T17, T23 | 1 |
| T26 | test | `/status` 与 `/resume` 的 yushan 分支 | T25 | 1 |
| T27 | impl | `comments.ts` 判据 + `channel.ts` 四处 N3 收敛 | T17, T23 | 3 |
| T28 | test | `usesFinalTextState` 语义与卡片正文非空 | T27 | 2 |
| T29 | impl | 图片文本引用 `[image: /path]` 拼进 prompt | T23 | 2 |
| T30 | test | yushan 走文本引用、codex 仍走 `--image` | T29 | 2 |
| T31 | impl | `yushan-history.ts` 读会话目录供 `/resume` | 无 | 2 |
| T32 | test | meta 重写形态、mtime 排序、id 格式不假定 | T31 | 1 |
| T33 | impl | web OnboardWizard 选项与 agent 检测候选 | T11 | 3 |
| T34 | test | web 类型与选项含 yushan | T33 | 1 |
| T35 | impl | README 写明 yushan 支持与 R7 限制 | 无 | 2 |
| T36 | test | README 契约含 yushan 与审批限制 | T35 | 1 |

**配对检查**：impl 为 T1/T3/T5/T7/T9/T11/T13/T15/T17/T19/T21/T23/T25/T27/T29/T31/T33/T35（18 个）；
test 为 T2/T4/T6/T8/T10/T12/T14/T16/T18/T20/T22/T24/T26/T28/T30/T32/T34/T36（18 个），一一配对。
**文件数检查**：所有任务涉及文件数 ≤ 5。

---

## B1 — 翻译器

### 任务 T1: 翻译器骨架：会话行、文本累积、工具对
- type: impl
- 依赖: 无
- 涉及文件: `src/agent/yushan/translate.ts`（新建）
- 描述: 新建 `YushanTranslator` 类，暴露 `translate(raw: unknown): AgentEvent[]`，信封形状为
  `{source, turn, event}`（先拆 `raw.event`，再按单 key 对象分派）。实现：
  (a) 会话行判别 `raw.type === 'session' && typeof raw.id === 'string'` → `[{type:'system', sessionId: raw.id}]`，
  且**不依赖行序**（谁先到谁先处理，会话行只记 id）；
  (b) `ModelTextDelta{text}` → 推入内部 `buffer`，本次**不产出任何事件**（B 案）；
  (c) `ModelStreamDiscarded{reason}` → `buffer = ''`，不产出事件；
  (d) `ToolCall{call:{id,name,arguments}}` → `{type:'tool_use', id, name, input: arguments}`；
  `ToolResult{id,result:{content,is_error}}` → `{type:'tool_result', id, output: content, isError: is_error}`；
  (e) `ModelThinkingDelta{text}` → `{type:'thinking', delta:text}`；
  (f) `UserMessage` / `RoundStarted` → `[]`；
  (g) 无法识别的事件累加 `drift.unknownEvents`、非法行累加 `drift.anomalies`，均产出 `[]`。
- 验收: `pnpm typecheck` 通过；`translate` 返回 `AgentEvent[]` 且**不改动** `AgentEvent` 契约
  （`tests/unit/agent/types-contract.test.ts` 仍绿）。

### 任务 T2: 翻译器基础映射断言
- type: test
- 依赖: T1
- 涉及文件: `tests/unit/agent/yushan-translate.test.ts`（新建）
- 描述: 新建测试文件，**内联构造**事件对象（不建 fixtures 目录）。断言下列具体行为：
  1. `{"id":"1794402820_061076000","type":"session"}` → 恰好
     `[{type:'system', sessionId:'1794402820_061076000'}]`；
  2. 连续 3 个 `ModelTextDelta`（`'当前目录只有两个文件：'` / ``'`fixture-normal.err`'`` / `' 和 `fixture-normal.ndjson`'`）
     每次 `translate` 都返回 `[]`（正文不外流）；
  3. 推入 delta 后再推 `ModelStreamDiscarded`，随后 `RunFinished` 产出的 `final_text.content === ''`
     （作废生效，前一段被清空）；
  4. `ToolCall` 精确产出
     `{type:'tool_use', id:'call_eb32de0e901240038ab5c57a', name:'ls', input:{path:'.'}}`；
  5. `ToolResult` 精确产出
     `{type:'tool_result', id:'call_eb32de0e901240038ab5c57a', output:'fixture-normal.err\nfixture-normal.ndjson', isError:false}`，
     另用一条 `is_error:true` 样本断言 `isError === true`；
  6. `ModelThinkingDelta{text:'想想'}` → `[{type:'thinking', delta:'想想'}]`；
  7. `UserMessage` 与 `RoundStarted` 均返回 `[]`；
  8. `{"event":{"DeferredResult":{}}}` 之类未知事件返回 `[]` 且 `translator.drift.unknownEvents === 1`；
     非对象行（`null`）使 `drift.anomalies === 1`。
- 验收: `pnpm vitest run tests/unit/agent/yushan-translate.test.ts` 全绿。

### 任务 T3: 翻译器终局：`RunFinished` / `RunFailed` / 退出码兜底
- type: impl
- 依赖: T1
- 涉及文件: `src/agent/yushan/translate.ts`
- 描述: 在 T1 基础上实现终局映射：
  (a) `RunFinished{stop_reason, usage, rounds}` → buffer 非空时先发
  `{type:'final_text', content: buffer}`，再发 `{type:'done', terminationReason}`；
  `stop_reason` 映射：`Completed`/`MaxRounds`/`Truncated` → `'normal'`；`Cancelled` → `'interrupted'`；
  `NoOutput` → `'normal'`（D5：公差为零、**不发** `final_text`）；
  (b) `RunFailed{error}` → `{type:'error', message: error, terminationReason: 'failed'}`，**不发** `done`；
  (c) 新增 `finishWithExitCode(exitCode: number, stderrTail: string): AgentEvent[]` 供 adapter 在
  stdout 结束时兜底调用：若已发过终局则返回 `[]`；否则 `0 → done{normal}`、
  `75 → done{interrupted}`、`1 → error{failed}`、其它非 0 → `error{failed}` 并附 stderr 尾部（截 500 字符）。
  内部用 `settled: boolean` 标记终局已发。
- 验收: 四种 `stop_reason` 均有确定输出；`RunFailed` 后 `settled === true`，兜底不再重发。

### 任务 T4: 终局四形态与兜底幂等断言
- type: test
- 依赖: T3
- 涉及文件: `tests/unit/agent/yushan-translate.test.ts`
- 描述: 追加测试，断言具体行为：
  1. 内联真实 17 行样本（8 个 delta + 2 个 `RoundUsage` + 工具对）逐条喂入后，
     `RunFinished{Completed}` 产出**两条**事件，第一条为 `final_text`，其 `content` 精确等于
     ``当前目录只有两个文件：`fixture-normal.err` 和 `fixture-normal.ndjson`，看起来像是一组测试夹具（fixture）输出。``
     （8 个 delta 的完整拼接，验证 C2）；
  2. 第二条为 `{type:'done', terminationReason:'normal'}`；
  3. `stop_reason:'Cancelled'` → `done{terminationReason:'interrupted'}`，`final_text` 仍按缓冲内容发出；
  4. `stop_reason:'NoOutput'` → **只有** `[{type:'done', terminationReason:'normal'}]`，
     `final_text` 不存在（`events.some(e=>e.type==='final_text') === false`）；
  5. `stop_reason:'MaxRounds'` 与 `'Truncated'` 均 → `normal`（参数化 `it.each`）；
  6. `RunFailed{error:'boom'}` → 恰好 `[{type:'error', message:'boom', terminationReason:'failed'}]`，无 `done`；
  7. 兜底：未发终局时 `finishWithExitCode(75,'')` → `done{interrupted}`；
     `finishWithExitCode(1,'panic')` → `error{failed}` 且 `message` 含 `panic`；
     `finishWithExitCode(3,'x'.repeat(900))` → `error{failed}` 且 `message` 长度 ≤ 600；
  8. 兜底幂等：`RunFinished` 之后再调 `finishWithExitCode(1,'')` 返回 `[]`。
- 验收: 同一 `pnpm vitest run tests/unit/agent/yushan-translate.test.ts` 全绿。

### 任务 T5: 翻译器 usage 去重（只发总量）
- type: impl
- 依赖: T3
- 涉及文件: `src/agent/yushan/translate.ts`
- 描述: 实现 C1 约束。`RoundUsage{purpose,round,usage}` **不产出任何事件**（仅内部记账，供调试日志）；
  `usage` 事件**只在 `RunFinished` 时产出一次**，取 `RunFinished.usage` 的总量：
  `input_tokens → inputTokens`、`output_tokens → outputTokens`、
  `prompt_cache_hit_tokens → cachedInputTokens`、`reasoning_tokens → reasoningOutputTokens`，
  `costUsd` 省略（YuShan 无成本信息）。产出顺序固定为 `final_text`（若有）→ `usage` → `done`。
  `RunFinished` 缺 `usage` 时不产 `usage` 事件（不猜 0）。
- 验收: `translate` 对 `RoundUsage` 恒返回 `[]`；每次运行 `usage` 事件最多一次；
  `src/bot/channel.ts:1617` 的 `reportMetric` 每次运行只被触发一次。

### 任务 T6: usage 恰好发一次且为总量
- type: test
- 依赖: T5
- 涉及文件: `tests/unit/agent/yushan-translate.test.ts`
- 描述: 追加测试，断言具体行为：
  1. 喂入 round1 `RoundUsage`（7814/37/0/0）与 round2 `RoundUsage`（7872/36/7808/0），
     两次 `translate` 都返回 `[]`（**不发 usage**）；
  2. 再喂 `RunFinished{usage:{input_tokens:15686,output_tokens:73,prompt_cache_hit_tokens:7808,reasoning_tokens:0}}`，
     把整段产出的扁平数组里 `type === 'usage'` 的元素筛出，断言**长度恰好为 1**；
  3. 该唯一 usage 事件 `toEqual({type:'usage', inputTokens:15686, outputTokens:73, cachedInputTokens:7808, reasoningOutputTokens:0})`，
     且 `'costUsd' in evt === false`；
  4. 断言 15686 既不等于 7814 也不等于 7872（证明确实用了总量而非某一轮）；
  5. 事件顺序：`final_text` 索引 < `usage` 索引 < `done` 索引。
- 验收: `pnpm vitest run tests/unit/agent/yushan-translate.test.ts` 全绿；usage 相关用例不少于 2 条。

---

## B2 — 适配器

### 任务 T7: `buildYushanArgs` 纯函数
- type: impl
- 依赖: 无
- 涉及文件: `src/agent/yushan/argv.ts`（新建）
- 描述: 实现 `buildYushanArgs(input: { sessionId?: string; prompt: string }): string[]`，顺序严格：
  `['--json']`，若有（非空字符串）`sessionId` 追加 `['--resume', sessionId]`，最后 `['--', prompt]`。
  prompt **恰好一个 token**，**不走 stdin**（YuShan `main.rs:356` 不支持 `-`）。
  纯函数、无 IO、无副作用。
- 验收: `pnpm typecheck` 通过；函数可直接 import 断言。

### 任务 T8: argv 顺序与 `--` 终止符断言
- type: test
- 依赖: T7
- 涉及文件: `tests/unit/agent/yushan-argv.test.ts`（新建）
- 描述: 断言具体行为（照 `codex-argv.test.ts` 风格）：
  1. `buildYushanArgs({prompt:'hi'})` `toEqual(['--json','--','hi'])`；
  2. `buildYushanArgs({sessionId:'1794402820_061076000', prompt:'hi'})`
     `toEqual(['--json','--resume','1794402820_061076000','--','hi'])`；
  3. `--json` 恒为 `args[0]`；有 `sessionId` 时 `args[1] === '--resume'` 且 `args[2] === sessionId`；
  4. `--` 恒为倒数第二个元素、prompt 恒为最后一个元素（对上面两例都断言）；
  5. prompt 以 `-` 开头不特判：`buildYushanArgs({prompt:'--stats'})` 末元素为 `'--stats'`
     且数组里 `'--stats'` 只出现一次；
  6. prompt 含空格/换行仍是单 token：`buildYushanArgs({prompt:'a b\nc'}).length === 3`
     且末元素 `=== 'a b\nc'`；
  7. `sessionId: ''` 视为无，结果 `toEqual(['--json','--','hi'])`（不带 `--resume`）；
  8. 边界：`sessionId` 含下划线时间戳形式 `'1794403057_979860000'` 时逐字保留，不被改写。
- 验收: `pnpm vitest run tests/unit/agent/yushan-argv.test.ts` 全绿。

### 任务 T9: `YushanAdapter` 实现
- type: impl
- 依赖: T3, T5, T7
- 涉及文件: `src/agent/yushan/adapter.ts`（新建）
- 描述: 实现 `YushanAdapter implements AgentAdapter`（`id: 'yushan'`、`displayName: 'YuShan'`），
  骨架照抄 `src/agent/codex/adapter.ts`：
  (a) 构造选项 `{binary, profileStateDir, stopGraceMs?, larkChannel?}`；
  `defaultStopGraceMs = Math.max(opts.stopGraceMs ?? 5000, 10_000)`（宽限默认 10s，理由见设计 §9）；
  (b) `checkAvailability()` 走既有 `checkAgentVersion`，`agentId:'yushan'`、`agentName:'YuShan'`、
  `command` 为 binary 路径；`isAvailable()` 返回其 `ok`；
  (c) `run(opts)`：`buildYushanArgs({sessionId: opts.sessionId, prompt: opts.prompt})`，
  `spawnProcess(binary, args, {cwd: opts.cwd, env, stdio:['pipe','pipe','pipe']})`，
  **立即** `child.stdin.end()`（prompt 在 argv，但不能留悬挂 stdin）；
  (d) env 覆盖经 `mergeProcessEnv(process.env, {...})`：
  `buildLarkChannelEnv(this.larkChannel)` + `YUSHAN_SESSIONS_DIR: join(profileStateDir,'yushan-sessions')`
  + **仅当 `opts.model` 非空**时 `YUSHAN_MODEL: opts.model` + `YUSHAN_DEBUG: '0'`；
  (e) stdout 用 `readline` 逐行 `JSON.parse` → `translator.translate(raw)`，
  解析失败计 `drift.anomalies` 不抛；
  (f) stderr 逐行 `log.warn('agent','stderr')` 并累积（截 500 字符供失败诊断）；
  (g) `stop()`：`SIGTERM` → 等 `defaultStopGraceMs` → `SIGKILL`，置 stopReason `'interrupted'`；
  `waitForExit(timeoutMs): Promise<boolean>` 同 codex；
  (h) stdout 结束后调 `translator.finishWithExitCode(exitCode, stderrTail)` 补终局（幂等）。
  **注意**：`opts.images` **不使用**（图片走 prompt 文本引用，见 T29）。
- 验收: `pnpm typecheck` 通过；`new YushanAdapter({...}).id === 'yushan'`；
  `AgentAdapter` 接口无缺口（`types-contract.test.ts` 仍绿）。

### 任务 T10: 适配器预检与环境注入断言
- type: test
- 依赖: T9
- 涉及文件: `tests/unit/agent/yushan-prepare-run.test.ts`（新建）
- 描述: 照 `codex-prepare-run.test.ts` / `adapter-system-prompt-wiring.test.ts` 的 mock 手法
  （`vi.hoisted` + `vi.mock('../../../src/platform/spawn')` + `EventEmitter`/`PassThrough` 假 child）。
  断言具体行为：
  1. binary 不存在时 `checkAvailability()` 返回 `{ok:false}`，`diagnostic.agentId === 'yushan'`、
     `diagnostic.code === 'agent-binary-not-found'`、`diagnostic.command` 为配置的 binary 路径；
  2. `run({prompt:'hi',cwd:'/tmp'})` 后 `spawnProcess` 调一次，第 2 参数 `toEqual(['--json','--','hi'])`；
     传 `sessionId:'s1'` 时 `toEqual(['--json','--resume','s1','--','hi'])`；
  3. `run()` 后 `child.stdin.readableEnded === true`（stdin 已 end）；
  4. env 含 `YUSHAN_SESSIONS_DIR` 且以 `yushan-sessions` 结尾、`YUSHAN_DEBUG === '0'`；
  5. `opts.model === undefined` 时 `'YUSHAN_MODEL' in env === false`；
     `opts.model === 'my-model'` 时 `env.YUSHAN_MODEL === 'my-model'`（两条独立用例）；
  6. 往 `child.stdout` 写内联真实 NDJSON（会话行 + 1 delta + `RunFinished{Completed}`）后，
     收到的事件类型序列为 `['system','final_text','usage','done']`；
  7. `stop()` 使 `child.kill` 首次入参为 `'SIGTERM'`；
  8. stdout 无终局事件即结束且 exit code 75 时，兜底收到 `done{terminationReason:'interrupted'}`。
- 验收: `pnpm vitest run tests/unit/agent/yushan-prepare-run.test.ts` 全绿。

---

## B4 — `agentKind: 'yushan'` 全线接入

### 任务 T11: 类型定义 6 处 + `AGENT_KINDS` 单一来源
- type: impl
- 依赖: 无
- 涉及文件: `src/config/profile-schema.ts`、`src/agent/preflight.ts`、`src/agent/capability.ts`、
  `src/cli/agent-detection.ts`、`web/src/lib/types.ts`
- 描述: 在 `src/config/profile-schema.ts:16` 抽单一来源：
  ```ts
  export const AGENT_KINDS = ['claude', 'codex', 'yushan'] as const;
  export type AgentKind = (typeof AGENT_KINDS)[number];
  export function isAgentKind(value: unknown): value is AgentKind;
  ```
  其余 5 处对齐：`preflight.ts:3` `LocalAgentId` 改为复用 `AgentKind`；
  `capability.ts:5` `AgentCapabilityId` 加 `'yushan'`；
  `capability.ts:6` `AgentSessionKind` 加 `'yushan-session'`；
  `cli/agent-detection.ts:5` 删掉重复定义，改为从 `profile-schema` 重导出 `AgentKind`；
  `web/src/lib/types.ts:1` 加 `"yushan"`。
- 验收: `pnpm typecheck` 通过；`grep -n "type AgentKind = 'claude' | 'codex'" src web` 为空。

### 任务 T13: profile 侧白名单放行 yushan
- type: impl
- 依赖: T11
- 涉及文件: `src/config/profile-schema.ts`、`src/config/profile-store.ts`、`src/config/migrate-v2.ts`
- 描述: 三处手写白名单改走 `isAgentKind(...)`：
  - `profile-schema.ts:251` 归一化白名单，错误文案同步为 `agentKind must be one of claude, codex, yushan`；
    并确保 `:255` 的 `raw.agentKind === 'codex' && !raw.codex` 约束**只对 codex** 生效
    （yushan 不需要 `codex` 配置段）；
  - `profile-store.ts:299` `agentKindFromString` 放行 `'yushan'`；
  - `migrate-v2.ts:203` 迁移白名单。
- 验收: `pnpm typecheck`；`agentKind:'yushan'` 的 profile 能通过归一化并被 `agentKindFromString` 接受。

### 任务 T12: `AGENT_KINDS` 与 profile 白名单断言
- type: test
- 依赖: T11, T13
- 涉及文件: `tests/unit/config/profile-schema.test.ts`
- 描述: 扩既有测试，断言具体行为：
  1. `AGENT_KINDS` `toEqual(['claude','codex','yushan'])`；`isAgentKind('yushan') === true`、
     `isAgentKind('bogus') === false`、`isAgentKind(undefined) === false`；
  2. `normalizeProfileConfig({schemaVersion:2, agentKind:'yushan', …})` 不抛，返回 `agentKind === 'yushan'`；
  3. `createDefaultProfileConfig({agentKind:'yushan', …})` 成功，且返回对象**不含** `codex` 字段；
     对照：`agentKind:'codex'` 缺 `codex` 仍抛 `/codex profile requires codex configuration/`；
  4. `agentKind:'bogus'` 抛错，且 message 含 `yushan`（新文案，不再是 claude-or-codex 旧文案）；
  5. `agentKindFromString('yushan') === 'yushan'`、`agentKindFromString(undefined) === undefined`、
     `agentKindFromString('bogus')` 抛 `/unsupported agent: bogus/`。
- 验收: `pnpm vitest run tests/unit/config/profile-schema.test.ts` 全绿。

### 任务 T14: 迁移与 profile-store 白名单断言
- type: test
- 依赖: T13
- 涉及文件: `tests/integration/config/profile-migration.test.ts`
- 描述: 扩既有集成测试，断言具体行为：
  1. 以 `agentKind:'yushan'` 走迁移路径（`migrateProfileV2WithActiveBridgePrompt` 或等价入口）后，
     落盘 profile 的 `agentKind === 'yushan'`（**不被拒绝、不被降级成 claude**）；
  2. 迁移后该 profile **不带** `codex` 段；
  3. `migrate-v2` 的 registry 白名单：输入含 `agentKind:'yushan'` 的活跃进程条目时，
     `activeProcesses` 里该条目**保留** `agentKind: 'yushan'`（旧实现会丢字段）；
  4. claude / codex 的既有迁移用例仍绿（回归）。
- 验收: `pnpm vitest run tests/integration/config/profile-migration.test.ts` 全绿。

### 任务 T15: 运行时白名单 + catalog 身份语义放行 yushan
- type: impl
- 依赖: T11
- 涉及文件: `src/runtime/locks.ts`、`src/runtime/registry.ts`、`src/agent/preflight.ts`、
  `src/session/catalog.ts`
- 描述: 四处改走 `isAgentKind(...)`：
  `locks.ts:181` lock meta 校验、`registry.ts:67` registry 条目校验、
  `preflight.ts:282` `isAgentPreflightDiagnostic` 的 `agentId` 白名单。
  **另（关键）** `src/session/catalog.ts` 三处让 yushan 与 claude 同侧（D2：走 sessionId）：
  - `:217` `normalizeEntry` 白名单加 `'yushan'`；
  - `:250` `isValidAgentEntry` → `if (entry.agentId === 'claude' || entry.agentId === 'yushan')
    return Boolean(entry.sessionId) && !entry.threadId;`
  - `:255` `assertAgentIdentity` 同款放行，错误文案区分 codex / 非 codex。
- 验收: `pnpm typecheck`；yushan 的 catalog 条目以 `sessionId` 存储且 `threadId` 恒 `undefined`。

### 任务 T16: catalog / locks / registry / preflight 放行 yushan
- type: test
- 依赖: T15
- 涉及文件: `tests/unit/session/catalog.test.ts`、`tests/unit/agent/preflight.test.ts`
- 描述: 断言具体行为：
  1. `upsertActive({agentId:'yushan', sessionId:'1794402820_061076000', …})` 不抛，
     `activeFor(...)` 返回条目且 `sessionId` 匹配、`threadId === undefined`；
  2. `upsertActive({agentId:'yushan', threadId:'t1', …})` **抛错**（yushan 不接受 threadId）；
  3. 落盘的 yushan 条目重新 `load` 后仍被接受（`normalizeEntry` 白名单生效，不被静默丢弃）；
  4. 同 scope 下 `agentId:'yushan'` 与 `agentId:'codex'` 的条目 `sessionCatalogKey` **不同**
     （不撞键，ADR 决策 1 的直接回归）；
  5. `isAgentPreflightDiagnostic({code:'agent-binary-not-found', agentId:'yushan', agentName:'YuShan',
     command:'ys-coding-agent'})` 返回 `true`（旧实现返回 false，会让 `/status` 丢诊断）；
  6. registry：写入 `agentKind:'yushan'` 的条目后 `listActive()` 能读回（不被 `isValidEntry` 过滤）；
  7. lock meta 含 `agentKind:'yushan'` 时被识别为有效 lock（读回成功）。
- 验收: `pnpm vitest run tests/unit/session/catalog.test.ts tests/unit/agent/preflight.test.ts` 全绿。

### 任务 T17: `yushanCapability` + capability 分派收敛
- type: impl
- 依赖: T11
- 涉及文件: `src/agent/capability.ts`、`src/bot/channel.ts`、`src/bot/comments.ts`、
  `src/bot/session-catalog-identity.ts`、`src/meeting/orchestrator.ts`
- 描述: 新增
  ```ts
  export function yushanCapability(_profile?: Pick<ProfileConfig,'permissions'>): AgentCapability {
    return { agentId:'yushan', sessionKind:'yushan-session', promptInjection:'stdin-prefix',
      systemPrompt: BRIDGE_SYSTEM_PROMPT, supportsNativeHistory: true,
      callback:{ marker:'__bridge_cb', legacyMarkers:[] },
      permissions:{ maxAccess:'full' } };   // D6：恒 full，不读 profile
  }
  ```
  另加 `export function capabilityForProfile(profile: ProfileConfig): AgentCapability` 单点三路分派
  （claude / codex / yushan），并把 4 处三元式改为调用它：
  `channel.ts:959`、`comments.ts:190`、`session-catalog-identity.ts:25`、`meeting/orchestrator.ts:299`。
- 验收: `pnpm typecheck`；`grep -rn "? codexCapability" src | grep -v capability.ts` 为空。

### 任务 T18: `yushanCapability` 契约断言
- type: test
- 依赖: T17
- 涉及文件: `tests/unit/agent/capability.test.ts`
- 描述: 扩既有文件，断言具体行为：
  1. `yushanCapability()` `toMatchObject({agentId:'yushan', sessionKind:'yushan-session',
     promptInjection:'stdin-prefix', supportsNativeHistory:true, systemPrompt:BRIDGE_SYSTEM_PROMPT,
     callback:{marker:'__bridge_cb', legacyMarkers:[]}})`；
  2. **D6 核心**：`it.each(['full','workspace','read-only'])` —— 无论 profile 的
     `permissions.maxAccess` 是哪档，`yushanCapability(profile).permissions.maxAccess` 恒为 `'full'`；
  3. `capabilityForProfile` 对三种 `agentKind` 分别返回 `agentId: 'claude' | 'codex' | 'yushan'`；
  4. codex 的 `maxAccess` 仍取 profile 值（`'workspace'`），与 yushan 的恒定 full 形成对照；
  5. claude / codex 既有断言不变（回归）。
- 验收: `pnpm vitest run tests/unit/agent/capability.test.ts` 全绿。

### 任务 T19: `supportedModels('yushan')` 分支（N2）
- type: impl
- 依赖: T11
- 涉及文件: `src/agent/models.ts`
- 描述: **关键静默错误修复。** 现状 `models.ts:46` 是
  `return agentKind === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;` —— yushan 会**落入 `CLAUDE_MODELS`**，
  于是 `resolveModelArg('yushan','claude-opus-4-8')` 返回该字符串，经 `YUSHAN_MODEL` 传给 YuShan
  （YuShan 不认识的模型名）。
  新增
  ```ts
  const YUSHAN_MODELS: ModelOption[] = [
    { value: DEFAULT_MODEL, label: '跟随 YuShan 配置（~/.yushan/state.json）' },
  ];
  ```
  并把 `supportedModels` 改为显式三分支或 `Record<AgentKind, ModelOption[]>` 映射表
  （**推荐映射表**：加第四种 agent 时编译期报错，避免同类遗漏）。
  效果：`normalizeModelSelection('yushan', <任意非默认值>)` 归一到 `DEFAULT_MODEL`，
  `resolveModelArg` 返回 `undefined`，`YUSHAN_MODEL` 不被设置（与 T9 的「仅非空才设」双重保障）。
- 验收: `pnpm typecheck`；`grep -n ": CLAUDE_MODELS" src/agent/models.ts` 为空（无隐式兜底）。

### 任务 T20: yushan 模型表仅含 `DEFAULT_MODEL`
- type: test
- 依赖: T19
- 涉及文件: `tests/unit/agent/models.test.ts`
- 描述: 扩既有文件，断言具体行为：
  1. `supportedModels('yushan')` 长度恰为 1，`[0].value === DEFAULT_MODEL`；
  2. `supportedModels('yushan').map(m=>m.value)` **不含** `'claude-opus-4-8'`、`'claude-sonnet-5'`、
     `'gpt-5-codex'`（N2 最直接的回归断言）；
  3. `resolveModelArg('yushan','claude-opus-4-8')` **返回 `undefined`**（现状返回该字符串，这就是 bug）；
  4. `normalizeModelSelection('yushan','claude-opus-4-8') === DEFAULT_MODEL`；
  5. `normalizeModelSelection('yushan','gpt-5-codex') === DEFAULT_MODEL`；
  6. `modelLabel('yushan', DEFAULT_MODEL)` 含 `YuShan`；
  7. claude / codex 既有断言不变（回归）。
- 验收: `pnpm vitest run tests/unit/agent/models.test.ts` 全绿。

### 任务 T21: 运行时装配 + 静默陷阱 2 处 + 显示名
- type: impl
- 依赖: T11, T9
- 涉及文件: `src/runtime/agent-runtime.ts`、`src/ui/onboard.ts`、`src/ui/qr-register.ts`、
  `src/cli/commands/service.ts`
- 描述:
  (a) `agent-runtime.ts:36` 之前加 yushan 分支：`agentKind === 'yushan'` 时
  `new YushanAdapter({ binary: <LARK_CHANNEL_YUSHAN_BIN ?? 'ys-coding-agent'>, profileStateDir: appPaths.profileDir,
  stopGraceMs: Math.max(configured, 10_000), larkChannel })`；
  并在 `checkRuntimeAgentAvailability` 的诊断兜底里加 yushan 的 `agentId` / `command`
  （现状是 `agent.id === 'codex' ? 'codex' : 'claude'` 的二元式，yushan 会被误标为 claude）。
  (b) **静默陷阱（最高优先级）**：`onboard.ts:80` 与 `qr-register.ts:155` 的
  `fv.agentKind === 'codex' ? 'codex' : 'claude'` 改为显式三路
  （`isAgentKind(fv.agentKind) ? fv.agentKind : 'claude'`，或 `agentKindFromString(...) ?? 'claude'`），
  否则 yushan 会被**静默变成 claude** 且 TypeScript 不报错。
  (c) `service.ts:607` `agentDisplay` 加 `yushan → {id:'yushan', displayName:'YuShan'}`。
- 验收: `pnpm typecheck`；`grep -rn "agentKind === 'codex' ? 'codex' : 'claude'" src/ui` 为空。

### 任务 T22: onboard / qr-register 不把 yushan 静默变成 claude
- type: test
- 依赖: T21
- 涉及文件: `tests/integration/ui/onboard.test.ts`
- 描述: 断言具体行为（复用 `mkdtemp` 临时 root）：
  1. `writeNewProfile({agentKind:'yushan', …}, root)` 落盘后 `loadRootConfig` 读回的
     `profiles.<name>.agentKind === 'yushan'`（**不是** `'claude'`）—— 静默陷阱的直接回归；
  2. 该 profile **不含** `codex` 字段；
  3. `writeNewProfile({agentKind:'bogus', …}, root)` 必须抛错（`/agentKind/` 或 `/unsupported agent/`），
     **不得**静默落盘成 claude（断言抛错后 config 里无该 profile）；
  4. claude 的既有用例仍绿（回归）。
- 验收: `pnpm vitest run tests/integration/ui/onboard.test.ts` 全绿。

### 任务 T23: `run-flow` 会话读写走 sessionId + 附件分流
- type: impl
- 依赖: T15, T17
- 涉及文件: `src/bot/run-flow.ts`
- 描述: 据 D2「yushan 走 sessionId，与 claude 同形」：
  (a) `:123` catalog 读：`if (catalogEntry?.agentId === 'claude')` 扩为
  `'claude' || 'yushan'` → 取 `sessionId`、`resumeFrom = sessionId`；
  (b) `:131` 的 `!resumeFrom && capability.agentId === 'claude'` 同样扩为 `|| 'yushan'`；
  (c) `:152` 附件分流改三分支，建议抽
  `attachmentTransport(agentId): 'flag' | 'text-ref' | 'stdin'`：
  codex → `'flag'`（`images: paths`）；yushan → `'text-ref'`（**不收 images**，改由 T29 拼进 prompt）；
  claude → `'stdin'`（`images: undefined`）；
  (d) `:191-209` catalog 写：claude 分支扩为 `'claude' || 'yushan'`，
  `upsertActive({agentId: capability.agentId, sessionId: evt.sessionId, …})`，
  yushan **不写** `threadId`。
- 验收: `pnpm typecheck`；yushan 首轮写 catalog、次轮 `resumeFrom` 非空。

### 任务 T24: yushan 走 sessionId 通路、续轮可 resume
- type: test
- 依赖: T23
- 涉及文件: `tests/integration/bot/im-run-flow.test.ts`
- 描述: 断言具体行为（用 `tests/helpers/fake-agent.ts` 注入 fake adapter）：
  1. 首轮 `startRunFlow({capability: yushanCapability(profile), …})` 返回 `ok:true`，
     `execution` 收到的 `sessionId === undefined` 且 `threadId === undefined`；
  2. 喂 `recordRunSessionEvent({event:{type:'system', sessionId:'1794402820_061076000', …},
     capability: yushanCapability(profile), …})` 后，
     `catalog.activeFor({agentId:'yushan', …})?.sessionId === '1794402820_061076000'` 且 `threadId === undefined`；
  3. 第二轮 `startRunFlow` 返回 `resumeFrom === '1794402820_061076000'`，且 `execution.sessionId` 等同该值；
  4. claude 的既有用例（同 scope 第二轮 resumeFrom）仍绿（回归）。
- 验收: `pnpm vitest run tests/integration/bot/im-run-flow.test.ts` 全绿。

### 任务 T25: `commands/index.ts` 的 `/resume`、`/status`、`/doctor` 分支
- type: impl
- 依赖: T15, T17, T23
- 涉及文件: `src/commands/index.ts`
- 描述:
  (a) `:560` / `:656` 的 `agentKind === 'codex'` 分支**保持 codex-only**，yushan 走其 else（claude 侧）；
  关键是 `:618/:639/:702/:703` 的 agentId 判别改为「codex 走 threadId，**其余全走 sessionId**」：
  `identity.agentId === 'codex' ? threadId 通路 : sessionId 通路`；
  `consumeResumeCandidate` 的校验从 `(identity.agentId === 'claude' && !candidate.sessionId)`
  改为 `(identity.agentId !== 'codex' && !candidate.sessionId)`；
  (b) `:765` `runtimeAccessStatus`：yushan 无 sandbox ⇒ 与 claude 同侧（label 为 `permission`、
  值由 `maxAccess` 派生），不得落到 `${sandbox.defaultMode}/${sandbox.maxMode}`；
  (c) `:815` / `:1131` 的 capability 选择改为 `capabilityForProfile(...)`（T17）；
  (d) `:721/:730` 历史 provider：yushan 走 `listYushanHistory`（T31），新增
  `ctx.yushanHistoryProvider?` 便于测试注入，目录取 `join(profileStateDir,'yushan-sessions')`
  —— **必须与 T9 的 `YUSHAN_SESSIONS_DIR` 是同一目录**，否则列表与实际续轮对不上。
- 验收: `pnpm typecheck`；`/status` 对 yushan profile 不显示 sandbox 三档。

### 任务 T26: `/status` 与 `/resume` 的 yushan 分支
- type: test
- 依赖: T25
- 涉及文件: `tests/integration/commands/resume-command.test.ts`
- 描述: 断言具体行为：
  1. yushan profile 下 `/resume` 走 sessionId 列表（不是 codex thread 列表）：
     注入 `yushanHistoryProvider` 返回 2 条含 `sessionId` 的摘要时，卡片含 2 个候选；
  2. 选中候选后 `applyResume` 使 `catalog.activeFor(identity)?.sessionId === <选中 id>`
     且 `threadId === undefined`；
  3. 无候选时回复文案**不含** `Codex`（不能复用「没有可恢复的 Codex thread」）；
  4. `/status` 对 yushan 的 `sessionId` 取 catalog 条目的 `sessionId`（非 `sessions.getRaw()`）；
  5. `/status` 的 `runtimeAccess.label` 对 yushan **不是** `'sandbox'`（断言具体 label 值）。
- 验收: `pnpm vitest run tests/integration/commands/resume-command.test.ts` 全绿。

### 任务 T27: `comments.ts` 判据 + `channel.ts` 四处 N3 收敛
- type: impl
- 依赖: T17, T23
- 涉及文件: `src/bot/comments.ts`、`src/bot/channel.ts`、`src/card/run-state.ts`
- 描述:
  (a) `comments.ts:246` 的 `capability.agentId === 'claude'` 扩为 `'claude' || 'yushan'`（sessionId 恢复）；
  `:250` 的 `=== 'codex'` 保持 codex-only；
  (b) **N3（关键）**：`channel.ts` L1172 / L1186 / L1237 / L1249 四处 `agentKind === 'codex'`
  —— **yushan 必须与 codex 同侧**。原因链：yushan 按 B 案不发 `text` 事件 ⇒ `state.blocks` 无正文；
  `renderText()`（`src/card/text-renderer.ts:18`）**只读 `blocks`、不读 `finalText`**；
  只有 codex 分支经 `finalReplyState()` / `finalAnswerOnlyState()` 把 `finalText` 转成 blocks。
  ⇒ 语义应是「**非 claude**」而非「是 codex」。抽单点（放在 `src/card/run-state.ts` 便于单测）：
  ```ts
  /** Agents that emit only `final_text` (no `text` deltas) need finalText→blocks
   *  promotion before rendering: `renderText` only reads `state.blocks`. */
  export function usesFinalTextState(agentKind: AgentKind): boolean {
    return agentKind !== 'claude';
  }
  ```
  四处判断替换为 `usesFinalTextState(controls.profileConfig.agentKind)`；
  同步 L1277 的 `=== 'codex' ? finalAnswerOnlyState(...) : ...` 改为 `usesFinalTextState`；
  L1182 / L1245 的 `if (kind !== 'codex') throw err;` 改为
  `if (!usesFinalTextState(kind)) throw err;`（yushan 同享「progress-stream 失败不抛」的容错）。
- 验收: `pnpm typecheck`；`grep -n "=== 'codex'" src/bot/channel.ts` 在上述六行无残留；
  `usesFinalTextState('yushan') === true`。

### 任务 T28: `usesFinalTextState` 语义与卡片正文非空
- type: test
- 依赖: T27
- 涉及文件: `tests/unit/card/run-state.test.ts`（新建或扩展现有）、`tests/unit/card/text-renderer.test.ts`
- 描述: 断言具体行为：
  1. `usesFinalTextState('claude') === false`、`usesFinalTextState('codex') === true`、
     **`usesFinalTextState('yushan') === true`**（核心断言）；
  2. `RunState`（`blocks: []`、`finalText: '答案正文'`）调 `renderText(...)` 后 `.trim() === ''`
     —— 证明「只靠 finalText 渲染不出来」，即 N3 的原因链；
  3. 对同 state 调 `finalAnswerOnlyState(...)` 后 `blocks` 含一段 `{kind:'text', content:'答案正文'}`，
     其 `renderText(...)` 结果含 `'答案正文'` —— 证明转 blocks 后才有正文；
  4. `reduce()` 对 `final_text` 事件只设 `finalText`、**不新增 block**
     （`state.blocks.length === 0`），这是 N3 成立的机制断言。
- 验收: `pnpm vitest run tests/unit/card` 全绿。

---

## B3/B6 — 模型 env 通路 + 图片文本引用

### 任务 T29: 图片文本引用拼进 prompt
- type: impl
- 依赖: T23
- 涉及文件: `src/bot/run-flow.ts`、`src/agent/prompt.ts`
- 描述: 据 §11 / D4：YuShan 不在输入侧解析图片路径，由模型自行调 `view_image`，
  故 bridge 把已接受附件以文本引用拼进 prompt。在 `buildAgentPrompt` 的 `user_input` 之后追加一节：
  ```
  ## attachments

  - [image: /path/to/a.png]
  - [file: /path/to/b.docx]
  ```
  `BuildAgentPromptInput` 加可选 `attachmentRefs?: Array<{kind: string; path: string}>`，
  仅在 `attachmentTransport(agentId) === 'text-ref'`（T23）时由 `run-flow` 传入；
  行格式固定 `- [<kind>: <path>]`。**不改** `AgentEvent` 契约、**不加** `--image` flag。
  注意 yushan 的 prompt 走 argv（argv 末元素），拼装发生在 `executor.submit({prompt})` 之前。
- 验收: `pnpm typecheck`；codex 的 `--image` 通路代码零改动。

### 任务 T30: yushan 走文本引用、codex 仍走 `--image`
- type: test
- 依赖: T29
- 涉及文件: `tests/integration/bot/attachment-run-flow.test.ts`、`tests/unit/agent/prompt-builder.test.ts`
- 描述: 断言具体行为：
  1. yushan + 1 张 `kind:'image'` + 1 个 `kind:'file'`（均 `decision:'accepted'`）→
     `execution` 收到的 `images` **为 `undefined`**（不走 flag）；
  2. 同一输入的 `opts.prompt` 含 `## attachments`，且含精确子串
     `- [image: /tmp/a.png]` 与 `- [file: /tmp/b.docx]`（含方括号、冒号后一个空格）；
  3. codex 同输入 → `images === ['/tmp/a.png']`（只含 image，过滤掉 file）；
  4. claude 同输入 → `images === undefined` 且 prompt **不含** `## attachments`
     （claude 走自有 stdin 协议，不能多平白一节）；
  5. `decision:'rejected'` 与 `'skipped'` 的附件不出现在引用文本里。
- 验收: `pnpm vitest run tests/integration/bot/attachment-run-flow.test.ts tests/unit/agent/prompt-builder.test.ts` 全绿。

---

## B5 — 会话历史

### 任务 T31: `yushan-history.ts`
- type: impl
- 依赖: 无
- 涉及文件: `src/session/yushan-history.ts`（新建）、`src/commands/index.ts`
- 描述: 新建 `listYushanHistory(input: { sessionsDir: string; limit?: number }): Promise<SessionSummary[]>`
  （`SessionSummary` 复用 `src/session/history.ts` 的 `{sessionId, mtime, preview, lineCount}`）。
  行为：
  (a) `sessionsDir` 由调用方传入且**必须是 adapter 用的同一个目录**
  （`join(profileStateDir,'yushan-sessions')`，即 `YUSHAN_SESSIONS_DIR`），
  否则 `/resume` 列表与实际续轮对不上；兜底默认 `join(homedir(), '.yushan', 'sessions')`；
  目录 `ENOENT` 返回 `[]` 不抛；
  (b) 扫 `*.jsonl`，按 `mtime` 降序取前 `limit`（默认 5）；
  (c) `sessionId` = 文件名去掉 `.jsonl`（形如 `1794403057_979860000`，**不要**解析成日期语义）；
  (d) `preview`：优先取首行 `{"type":"meta",...}` 的 `title`（经 `normalizeSessionPreview` 截断）；
  meta 缺失或 `title` 为空时回退到第一个 `{"role":"User"}` 行的 `content[0].Text.text` 截断；
  (e) `lineCount` 直接数行。
  **实测坑（必须写成实现注释）**：YuShan 在 `--resume` 后**整体重写**会话文件 ——
  `meta.title` 变成**最新一轮**的任务文本（不是会话主题）、`meta.turns` **不可信**
  （实测 2 个完整回合仍写 `turns:1`）、`meta.input_tokens` / `output_tokens` 是**单轮值**。
  ⇒ 预览用 `title` 是「最近在聊什么」的诚实近似；**绝不用 `turns` 推算回合数**，也不展示 token 数。
- 验收: `pnpm typecheck`；空目录返回 `[]`；resume 后的 5 行样本能正确产出预览。

### 任务 T32: meta 重写形态、mtime 排序、id 格式不假定
- type: test
- 依赖: T31
- 涉及文件: `tests/unit/agent/yushan-history.test.ts`（新建）
- 描述: 用 `mkdtemp` 建临时目录、`writeFile` 内联写入样本（**不建 fixtures 目录**）。断言具体行为：
  1. **resume 重写形态（核心）**：写入这个 5 行样本
     ```jsonl
     {"type":"meta","v":1,"title":"我刚才让你记住的数字是多少？只回复数字","provider":"opencode-go","model":"deepseek-v4.1-flash","input_tokens":7829,"output_tokens":3,"turns":1}
     {"role":"User","content":[{"Text":{"text":"记住数字 42，只回复『好』"}}]}
     {"role":"Assistant","content":[{"Text":{"text":"好"}}]}
     {"role":"User","content":[{"Text":{"text":"我刚才让你记住的数字是多少？只回复数字"}}]}
     {"role":"Assistant","content":[{"Text":{"text":"42"}}]}
     ```
     断言 `preview` 取到 `meta.title` 那句（**不是**首轮的 `记住数字 42`），
     `lineCount === 5`，且返回对象的键集合里**没有**任何由 `turns` 推导的回合数字段；
  2. meta 缺失（仅 `role` 行）时回退到首个 `{"role":"User"}` 的 `content[0].Text.text`
     （断言 `preview` 含 `记住数字 42`）；
  3. `meta.title` 为空字符串 `""` 时同样回退（不返回空预览）；
  4. mtime 排序：写 A 后 `utimes` 使 B 更新，断言 `[0].sessionId` 是 B；
  5. `limit` 生效：目录放 3 个文件、`limit:2` 返回 2 条；
  6. `sessionId` 即文件名主体：`1794403057_979860000.jsonl` 得到
     `sessionId === '1794403057_979860000'`（**不**被解析/改写成日期格式）；
  7. 空目录与不存在的目录均返回 `[]` 不抛。
- 验收: `pnpm vitest run tests/unit/agent/yushan-history.test.ts` 全绿。

---

## Web 与文档

### 任务 T33: web OnboardWizard 选项与 agent 检测候选
- type: impl
- 依赖: T11
- 涉及文件: `web/src/views/OnboardWizard.tsx`、`web/src/lib/types.ts`、`src/cli/agent-detection.ts`
- 描述: `OnboardWizard.tsx:135` 的 `Select` 加 `<SelectItem value="yushan">YuShan</SelectItem>`；
  `:188` 的「未检测到已安装的 agent」文案改为「claude、codex 或 yushan」；
  `src/cli/agent-detection.ts:50` 候选列表加
  `{ kind: 'yushan', command: process.env.LARK_CHANNEL_YUSHAN_BIN ?? 'ys-coding-agent' }`。
- 验收: `pnpm typecheck` 与 `pnpm build:web` 均通过。

### 任务 T34: web 类型与选项含 yushan
- type: test
- 依赖: T33
- 涉及文件: `tests/unit/docs/readme-contract.test.ts`
- 描述: `web/` 无单测基建，采用**源码文本契约断言**（与既有 readme-contract 同风格）。断言具体行为：
  1. `web/src/lib/types.ts` 的 `AgentKind` 行含 `"yushan"`；
  2. `OnboardWizard.tsx` 含 `value="yushan"` 且含 `YuShan` 文案；
  3. `OnboardWizard.tsx` 的空态提示文案含 `yushan`（检测不到 agent 时不遗漏该选项）；
  4. `src/cli/agent-detection.ts` 含 `ys-coding-agent` 与 `LARK_CHANNEL_YUSHAN_BIN`。
- 验收: `pnpm vitest run tests/unit/docs/readme-contract.test.ts` 全绿。

### 任务 T35: README 写明 yushan 支持与 R7 限制
- type: impl
- 依赖: 无
- 涉及文件: `README.md`、`README.zh.md`
- 描述: 两份 README 同步加 yushan 说明：`ys-coding-agent` 作为第三种受支持 agent、
  安装与 `LARK_CHANNEL_YUSHAN_BIN` 覆盖、会话目录 `YUSHAN_SESSIONS_DIR`（per-profile 隔离）、
  **R7 限制**：「yushan 不支持只读档，工具审批恒为自动批准（AutoApprove）」——
  让用户在创建 profile 前就知道该限制。
- 验收: 两份 README 均含 `yushan` / `ys-coding-agent` 段落与审批限制说明。

### 任务 T36: README 契约含 yushan 与审批限制
- type: test
- 依赖: T35
- 涉及文件: `tests/unit/docs/readme-contract.test.ts`
- 描述: 扩既有 readme 契约测试，断言具体行为：
  1. `README.md` 与 `README.zh.md` 均含 `ys-coding-agent`；
  2. 均含 `YUSHAN_SESSIONS_DIR` 与 `LARK_CHANNEL_YUSHAN_BIN`；
  3. 均含审批限制表述（英文含 `AutoApprove` 或 `auto-approve`，中文含 `自动批准`）；
  4. 均**不含**声称 yushan 支持只读档的表述（如英文 `read-only` 紧邻 `yushan` 的肯定句——
     以实现确定的措辞断言，避免误判）。
- 验收: `pnpm vitest run tests/unit/docs/readme-contract.test.ts` 全绿。

---

## 完成判据

全部任务完成后，下列命令必须全部通过：

```bash
pnpm vitest run tests/unit/agent/yushan-translate.test.ts
pnpm vitest run tests/unit/agent/yushan-argv.test.ts
pnpm vitest run tests/unit/agent/yushan-prepare-run.test.ts
pnpm vitest run tests/unit/agent/yushan-history.test.ts
pnpm vitest run tests/unit/agent/capability.test.ts
pnpm vitest run tests/unit/agent/models.test.ts
pnpm vitest run tests/unit/agent/preflight.test.ts
pnpm vitest run tests/unit/session/catalog.test.ts
pnpm vitest run tests/unit/config/profile-schema.test.ts
pnpm vitest run tests/unit/card
pnpm vitest run tests/integration/config/profile-migration.test.ts
pnpm vitest run tests/integration/bot/im-run-flow.test.ts
pnpm vitest run tests/integration/bot/attachment-run-flow.test.ts
pnpm vitest run tests/integration/commands/resume-command.test.ts
pnpm vitest run tests/integration/ui/onboard.test.ts
pnpm vitest run tests/unit/docs/readme-contract.test.ts
pnpm vitest run tests/unit --passWithNoTests
pnpm typecheck
```

另需满足（可用 grep 复核）：

- `tests/unit/agent/types-contract.test.ts` 仍绿（**未改 `AgentEvent` 契约**）；
- claude / codex 既有测试零回归（A5）；
- `grep -rn "agentKind === 'codex' ? 'codex' : 'claude'" src/ui` 为空（静默陷阱已清除）；
- `grep -rn "? codexCapability" src | grep -v capability.ts` 为空（三元式已收敛）；
- `grep -n ": CLAUDE_MODELS" src/agent/models.ts` 为空（N2 已修，无隐式兜底）；
- `grep -n "=== 'codex'" src/bot/channel.ts` 在 L1172/L1186/L1237/L1245/L1249/L1277 无残留（N3 已收敛）；
- 真实飞书端到端 A1–A5 为 **MANUAL_ACK_REQUIRED**，不在本计划的自动验证范围内。
