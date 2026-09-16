# agent 服务

她的**脑子**：工具调用 + MCP + 记忆 + 历史压缩。

结构借自用户已有项目 `nexus-desktop/server/src/services/`（LangChain `createAgent`
+ zod 工具 + `@langchain/mcp-adapters` + md 记忆 + 渐进式历史压缩），
人设和工具集换成了陪伴场景。

## 跑起来

```powershell
cd agent
pnpm install
pnpm dev            # http://127.0.0.1:8766
```

要让它单独能跑（不靠应用发配置），把 `.env.example` 复制成 `.env` 填上 key。

## 接口

| 接口 | 作用 |
|---|---|
| `POST /chat` | SSE 对话。事件：`content` / `tool_call` / `tool_result` / `command` / `done` / `error` |
| `GET /health` | 探活 + MCP 状态 + 记忆条数 |
| `GET /tools` | 内置工具清单 + MCP 工具数 |
| `GET /memory` | 她记得什么（含历史摘要） |
| `POST /memory/clear` | 让她忘掉 |

`POST /chat` 的请求体：

```jsonc
{
  "messages": [{ "role": "user", "content": "…" }],  // 历史（服务端会按需压缩）
  "input": "在吗",                                    // 这一句
  "llm": { "baseURL": "…", "apiKey": "…", "model": "…" },  // 来自应用设置面板
  "systemPrompt": "…",                                // 可选：应用自己那套人设
  "sessionId": "default"                              // 可选：分会话存摘要
}
```

## 工具

| 工具 | 干什么 | 为什么需要 |
|---|---|---|
| `search_web` | 联网查（Tavily → DuckDuckGo 兜底） | 会变的事（新闻/价格/版本）不能靠记忆 |
| `get_time` | 现在几点、周几 | 她得知道该不该催你睡觉 |
| `remember` | 把关于你的事长期记下来 | 自动提取会漏掉"这句话很重要" |
| `show_expression` | **换表情**（发给界面执行） | 让"她说的话"和"她的脸"是一件事 |
| `respond` | 闲聊占位 | 闲聊也走工具，模型更稳（人家那套经验） |

外加 MCP 提供的全部工具（默认挂 Playwright，能自己开浏览器看一眼）。

## 记忆是怎么长出来的

```
一轮对话结束
   → 后台问一次模型："这段对话里有关于他的、值得长期记住的事吗？"
   → 有 → 覆盖写 data/memory/user.md（完整重写，不是追加）
   → 没有 → NO_UPDATE，什么都不做
下次开口
   → data/memory/*.md 全部塞进 system prompt（几十条级别，不需要向量库）
```

为什么不上向量库：陪伴的记忆量是几十条，全塞进提示词放得下（实测 20 条约 1.5k token）；
检索的复杂度、embedding 依赖、召回不准的风险都是净负担。真到几百条再换存储层，
接口只有 `loadMemory()` / `saveMemory()` 两个函数。

## 历史压缩

超过 30 轮（60 条消息）→ 旧消息压成结构化摘要（近况 / 约定 / 他喜欢什么 / 聊到哪了），
最近 30 轮保留原文；摘要落盘并随对话**合并更新**。压缩失败就退化为截断 ——
摘要是优化，聊不下去才是事故。
