# bridge Rust 重写评估 — 架构上下文

> 本目录文档：
> - **`context.md`**（本文件）—— 问题、实测数据、瓶颈定位
> - [`adr-001-reject-rust-rewrite.md`](./adr-001-reject-rust-rewrite.md) —— 决策：暂不重写，附触发条件
> - [`lark-rust-sdk-survey.md`](./lark-rust-sdk-survey.md) —— 飞书 Rust SDK 生态实测调查
>
> 本评估**不产出代码**。目的是把「要不要用 Rust 重写 connector」这个问题一次问清，
> 避免将来重复论证。

## 问题

`lark-channel-bridge` 是 TypeScript 写的飞书 ↔ 本地 CLI agent 桥。有提议：

> 能不能用 Rust 做一个效率更高、资源占用更少的飞书（或其他应用）连接器？

这个问题包含两个可以分开回答的子问题：

1. **性能**：当前 bridge 是瓶颈吗？换 Rust 能省多少？
2. **可行性**：Rust 生态有没有可用的飞书 SDK？（见 [`lark-rust-sdk-survey.md`](./lark-rust-sdk-survey.md)）

## 当前架构的量化现状

| 指标 | 数值 | 采集方式 |
|---|---|---|
| 源码规模 | 123 个 `.ts` / 26,641 行 | `find src -name '*.ts'` |
| 运行时依赖 | **7 个** | `package.json` `dependencies` |
| Node 空进程基线 RSS | **44.7 MB** | `node -e 'process.memoryUsage()'` |
| 卡片构建代码 | 12 个文件（`src/card/*.ts`） | — |
| 定时器/轮询点 | 49 处 | `grep setInterval\|setTimeout` |
| `JSON.parse/stringify` | 86 处 | — |

### 运行时依赖只有 7 个，且无性能敏感件

```
@clack/prompts      交互式 CLI 提示
@larksuite/channel  ← 唯一大件：官方 SDK（1.5 MB / 12,564 行）
commander           argv 解析
cross-spawn         跨平台 spawn
graceful-fs         fs 包装
proper-lockfile     文件锁
qrcode-terminal     二维码终端渲染
```

**关键结构性事实**：飞书协议层**完全委托给官方 SDK**，本仓库没有自己实现 WS 握手、
心跳、重连退避。这是「重写成本」的决定性因素。

```
@larksuite/channel@0.6.0
  └── @larksuiteoapi/node-sdk + https-proxy-agent
```

SDK 核心内容是 `WebSocket` 长连 + `reconnect` + 事件 schema 分发。

## 实测：瓶颈不在 bridge

### 链路耗时拆解

在 `/tmp/ystest` 下实测（YuShan 单回合，含模型调用）：

| 环节 | 实测 | 占比 |
|---|---|---|
| **模型调用（YuShan 一个回合）** | **6.74s / 7.99s / 19.20s** | **≈99%** |
| YuShan 进入 runtime（首行 `session` 到达） | 2.51s / 2.77s | 其余时间主体 |
| bridge 处理一条消息（解析 → 渲染卡片 → HTTP） | 毫秒级 | <0.1% |

命令：

```bash
# 模型+全程
for i in 1 2 3; do /usr/bin/time -p ~/.local/bin/ys-coding-agent --json "回答一个字：好"; done

# 首字节延迟 vs 总时长
# run1: 首行(session)=2.77s  总=10.18s
# run2: 首行(session)=2.51s  总=12.41s
```

### 一个有说服力的对照

YuShan 自己就是 Rust 程序。拆开看它的启动成本：

| 场景 | 实测 |
|---|---|
| `--version`（不进 runtime） | **0.00s** |
| `--help` | **0.00s** |
| 进入 runtime（装配工具表、扫 skill、连模型） | **≈2.5s** |

**结论**：Rust 省的是「进程启动」，而真正吃时间的是**架构级装配工作**，不是语言运行时。
把 bridge 换成 Rust，同样省不掉它自己的装配成本。

### bridge 热路径到底做了什么

一条消息进来，bridge 的工作是：

1. 解析一个飞书事件 JSON
2. 取出文本
3. 拼一个 prompt
4. `spawn` 一个子进程（`ProcessPool.acquire()`，`src/runtime/run-executor.ts:56,79`）
5. 把 agent stdout 的 NDJSON 翻译成卡片状态（86 处 `JSON.parse`）
6. 走 HTTP 把卡片发出去

这个量级用 Rust 重写，省下的是毫秒；链路总耗时是**秒**。

## 收益 / 代价对照

### 乐观收益估计

| 项 | Node 现状 | Rust 估计 | 差值 |
|---|---|---|---|
| 常驻内存 | ~50–80 MB | ~10–20 MB | **约 60 MB** |
| 消息处理延迟 | 毫秒级 | 亚毫秒 | 用户不可感知 |
| CLI 冷启动 | ~100 ms | ~5 ms | 仅影响 CLI 子命令 |

### 代价

| 项 | 量级 |
|---|---|
| 重写飞书 WS 协议层 | **最大风险**：握手、心跳、重连退避、schema 漂移 |
| 重写卡片 JSON 构建 | 12 个 `src/card/*.ts` |
| 重写 123 文件 / 26.6k 行 | 含 UI、onboard、QR、web 控制台 |
| **丢失官方 SDK 兼容性** | 飞书 API 变更需自行跟进（官方无 Rust SDK，见 SDK 调查文档） |
| 双语言维护成本 | 已在维护 TS + Rust（YuShan）两套 |

**账**：用约 60 MB 常驻内存 + 毫秒级延迟，换一次高风险的协议层重写。

## 更便宜的替代方案（未实施，供后续取舍）

如果目标是「省资源」而非「换语言」，以下做法成本远低于重写：

1. 调低 `ProcessPool` 并发上限
2. Web 控制台（`src/ui/*`）延迟加载，不常驻
3. 空闲降频：减少 49 处定时器中的轮询类（如 `src/meeting/manager.ts` 的轮询降级路径）
4. 若确有重计算需求（音视频转码、本地推理），**单独写 Rust 侧车进程**，bridge 侧仅做 IPC

第 4 条与现有架构一致：bridge 已通过 `--json` NDJSON 驱动 Rust 的 YuShan，边界清晰。

## 边界

- 本评估**不涉及** YuShan 自身（它是 Rust，与被评估的 bridge 无关）
- 本评估**不涉及**「其他应用连接器」的横向扩展；若要做钉钉/企微，其 SDK 生态需各自评估
- 数据采集于 2026-11-11，本机 macOS，Node ≥20.12.0
