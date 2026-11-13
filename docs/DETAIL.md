# Free web search

给 DeepSeek Harness（dsh）注册一个不需要 API key 的网页搜索 provider，替换掉官方那条依赖中转站/官方 key 的链路。

## 它做什么

`web_search` 调用时按顺序尝试免 key 渠道，拿到第一份非空结果就返回。

**顺序按查询语言分流**：

| 查询 | 顺序 | 理由 |
|---|---|---|
| 拉丁查询（CJK 占比 < 50%） | Bing → Firecrawl → Exa | Bing 直连几百毫秒就出结果 |
| 中文查询（CJK 占比 ≥ 50%） | Firecrawl → Exa → Bing | Bing 会把中文长查询截断成首字，返回字典页 |

| 渠道 | 端点 | 特点 |
|---|---|---|
| Bing | `https://www.bing.com/search`（抓 HTML） | 最快；中文长查询不可靠 |
| Firecrawl | `https://api.firecrawl.dev/v2/search` | 中文最稳，4–6 秒 |
| Exa | `https://mcp.exa.ai/mcp`（匿名 MCP） | 摘要最好，但匿名额度极易挂死 |

全部失败才抛错，错误信息带每一家的失败原因。回退时结果里带一句 `(free search fell back to <渠道>)`。

## 失败冷却

某个渠道抛错后，3 分钟内不再尝试它（内存 + `~/.dsh/web-search-free.state.json`，重启不清零）。冷却中的渠道一旦成功即解冻。若所有渠道都在冷却，会清空冷却强行跑一轮，避免「都冷却 = 搜索全挂」。

## 注册与选中

- provider id 固定为 `free`，注册进 `ctx.web`。
- `cordis.patch.yml` 把 `web.searchProvider` 指到 `free`，同时显式写回 `fetchProvider: http`——**只换搜索，不碰 web_fetch**。
- 该 patch 覆盖 `web` 整段 config，两个字段都必须写全。

## 限制

- 三家都是**匿名额度**，没有配额保证，随时可能限流或改结构。
- 单渠道超时：Bing 8s / Firecrawl 9s / Exa 6s；全挂时最坏约 23 秒。
- 不做时间过滤（`timeRange` 会被忽略）。
- 只做 URL 去重与条数截断，不做相关性重排。
- 依赖出网直连，不需要代理；换网络环境后要重测。
- **改完 `index.js` 必须重启 DSH** 才生效。

## 回滚

在「插件」页停用本 bundle，或用 `plugin_manager` 的 `remove_bundle` 移除。移除后 `web.searchProvider` 回到未配置状态，DSH 使用出厂默认 provider。
