# 飞书 Rust SDK 生态调查

调查日期：2026-11-11。数据来自 crates.io API 与各仓库页面实测抓取。

## 结论先行

**飞书官方没有 Rust SDK。** 服务端 SDK 官方只提供 5 种语言：

| 语言 | 官方支持 |
|---|---|
| Golang / Python / Java / NodeJS / PHP | ✅ |
| **Rust** | ❌ **无** |

用户当前使用的 `@larksuite/channel` 属于官方 Node SDK 分支，由 `larksuite` 官方组织维护。

## 社区 crate 实测对比

| crate | 版本 | 下载量 | 最近更新 | Star | WS 长连接 | 发布状况 |
|---|---|---|---|---|---|---|
| **`larksuite-oapi-sdk-rs`**<br>`adamcavendish/larksuite-oapi-sdk-rs` | 0.3.13 | 4,266 | 2026-10-28 | 12 | ✅ **可用**<br>`ws` feature，protobuf 分帧 | crates.io |
| **`open-lark`**<br>`foxzool/openlark` | 0.14.0<br>（repo 标 0.21.0） | 33,307 | 2025-09-30 | 113 | ⚠️ **部分**<br>「WebSocket 功能完善」列为**计划中** | crates.io |
| **`feishu-sdk`**<br>`palpo-im/feishu-sdk` | 0.1.2 | 17,377 | 2026-03-07 | 2 | ✅ 有（`websocket` feature） | crates.io |
| **`oapi-sdk-rust`**<br>`partme-ai/oapi-sdk-rust` | — | — | — | — | ❌ **仅计划中** | **未发布**，只能 git 依赖 |

### 逐项说明

#### `larksuite-oapi-sdk-rs`（WS 支持最完整）

- `ws` Cargo feature 提供 "WebSocket long-connection event client with protobuf framing"
- 附 `examples/ws_client.rs` 可直接照抄验证
- 覆盖 IM / Calendar / Drive / Docs / Sheets / Bitable / Contacts / Approval / VC / Wiki / Hire
- 支持 tenant / user / app / marketplace token 获取、缓存与重试
- 有 DPoP proofs、webhook 签名校验、加密事件解密
- features：`ws` / `messaging` / `channel` / `axum`
- **注意**：MSRV **Rust 1.95.0**、edition 2024（工具链要求很新）
- 640 commits，但仅 12 star

#### `open-lark`（下载量最高，但 WS 未完善）

- 下载量 33,307，是三家中最高
- 18 个业务模块、1,642 个目录 API、声称 100% 覆盖
- 卡片支持较完整（`openlark-cardkit` 10 个 API）
- 消息发送（`openlark-communication` 179 个 API）、云盘上传均有
- **主要顾虑**：
  - 「WebSocket 功能完善」和「更多事件处理器支持」都还在**计划中**
  - 测试覆盖率自称 **约 47%**
  - 依赖 `lark-websocket-protobuf`（对比调查时版本 0.1.2，同类单作者仓库）——**单点依赖**
- 业务模块状态自称「持续完善」，仅 core / client / auth 称生产就绪

#### `feishu-sdk`（早期项目）

- 2 star、12 commits，无 release
- 声称 1448+ operations，但 typed model 自述为 "model stubs"
- 有 `WebSocketClient` / `WsConfig`（含 heartbeat/reconnect 配置）
- 卡片仅有 callback 处理，**无卡片构建 API**

#### `oapi-sdk-rust`（未发布，不可用）

- README 自称「生产级」，对齐官方 Java SDK
- **但 WebSocket long connection 在能力表中标为 planned，无 ✓**
- 未发布到 crates.io，安装方式是 git 依赖
- 自述为社区实现，非官方维护

## 对 bridge 重写的含义

bridge 依赖的核心能力正是 **WS 长连接收取事件**。调查结果：

1. **官方不做 Rust** → 这一层永远由社区维护
2. 社区中 WS 最可用的是 `larksuite-oapi-sdk-rs`，但仅 **12 star / 4,266 下载**
3. 下载量最高的 `open-lark`（33k）**恰恰 WS 未完善**
4. Rust 版长连接协议栈（`lark-websocket-protobuf`）出自单作者仓库，版本号仍在 0.1.x

对比现状：`@larksuite/channel` 由官方组织维护，出问题可提 issue、API 变更有人跟进。

**换 Rust 等于把官方维护的协议层换成 star 两位数的社区库** —— 这是上一轮评估中
「最大风险在重写 WS 协议层」的具体证据。

## 若将来真要做的建议路径

1. **用 `larksuite-oapi-sdk-rs` 起步**（唯一把 WS 做成可用 feature 且带示例的）
2. **先做技术验证，不重写**：写几十行程序连上长连接，收一条消息、发一条卡片
3. 验证通过再谈迁移；验证不通过则方案当场否决，不浪费任何重写工作

## 数据采集命令

```bash
# crates.io 元数据
for c in open-lark larksuite-oapi-sdk-rs feishu-sdk oapi-sdk-rust; do
  curl -s "https://crates.io/api/v1/crates/$c" -H "User-Agent: research" \
    | python3 -c "import sys,json; d=json.load(sys.stdin)['crate']; \
      print(d['name'], d['max_version'], d['downloads'], d['updated_at'][:10])"
done

# 官方 SDK 语言清单
curl -s "https://open.feishu.cn/document/server-docs/server-side-sdk" \
  | sed 's/<[^>]*>//g' | grep -io "golang\|python\|java\|nodejs\|php\|rust" | sort | uniq -c
```

## 时效性提醒

crates.io 数据与仓库状态会变。**本调查有效期约 3–6 个月**；若超过 2027-05 再引用，
应重新抓取上述指标，特别是 `open-lark` 的 WS 是否已从「计划中」转为完成。
