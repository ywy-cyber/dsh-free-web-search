# dsh-free-web-search

**给 DeepSeek Harness（dsh）的免 key 网页搜索。** 不需要 API key、不产生计费、不用代理 —— 三个公开接口组成一条带语言路由的失败回退链。

[English](README.md)

---

## 为什么做这个

dsh 自带的搜索 provider 依赖 DeepSeek 官方 API key，两种常见场景会卡住：

- **没有官方 key**：用第三方模型网关跑 DSH 时，`web_search` 无法鉴权，直接失败。
- **有官方 key，但用第三方模型**：搜索仍走 DeepSeek 自己的端点，即使对话跑在别处，账户照样扣费。

这个插件只替换 `ctx.web` 的**搜索**一侧，换成完全不需要凭据的公开接口。它**不动 `web_fetch`**，抓取仍用你原来的 provider。

## 怎么搜

只有一个 provider，id 是 `free`。每次请求沿一条短链依次尝试，拿到第一份非空结果就返回。顺序按查询语言分流，因为几个后端的毛病不一样：

| 查询语言 | 顺序 | 理由 |
|---|---|---|
| 拉丁（CJK 字符占比 < 50%） | Bing → Firecrawl → Exa | Bing 一般几百毫秒就出结果 |
| 中文（CJK 字符占比 ≥ 50%） | Firecrawl → Exa → Bing | Bing 会把中文长查询改写成单个字，返回该字的字典页 |

| 后端 | 端点 | 特点 |
|---|---|---|
| Bing | `https://www.bing.com/search`（抓 HTML） | 最快；只用于拉丁查询 |
| Firecrawl | `https://api.firecrawl.dev/v2/search` | 综合最稳，1–6 秒，中文表现好 |
| Exa | `https://mcp.exa.ai/mcp`（匿名 MCP） | 摘要质量最好，但匿名额度极易挂死 |

抛错的后端会被停用 3 分钟，记在内存和 `~/.dsh/web-search-free.state.json` 里，避免每次搜索都去撞一个正在限流的端点。如果所有后端都在停用期，会清空记录强行跑一轮 —— 搜索不会因为过期的记账而整体失败。

发生过回退时，结果里会带一句 `(free search fell back to <后端>)`，方便判断实际是谁出的结果。

## 安装

需要带 `ctx.web` seam（`@deepseek-ai/dsh-web`）的 dsh。CLI 需要 Node 20+。

**从本地目录装：**

```sh
git clone https://github.com/ywy-cyber/dsh-free-web-search.git
dsh plugin --profile <你的profile> add ./dsh-free-web-search
```

或在 DSH 里用「插件 → 添加插件」选这个目录。

**装完必须重启 DSH。** provider 以 ES 模块加载，不会被热替换。

## 它改了 profile 里的什么

bundle 的 patch 插入一行，并把 web seam 指过去：

```yaml
- insert:
    - id: web-search-free
      name: 'dsh-free-web-search'
- id: web
  config:
    searchProvider: free
    fetchProvider: http
```

`- id: web` 这个覆盖是**整段替换**，所以两个字段都要写全。`fetchProvider: http` 是出厂默认 —— 只换搜索，不换抓取。

想回到原生 provider：卸载本 bundle，`searchProvider` 变回未设置，dsh 走自己的默认。

> 如果你还装了别的会注册 fetch provider 的插件，把这里的 `fetchProvider` 改成那个插件的 id，否则会被这条 patch 覆盖掉。

## 命令行

```sh
node cli.mjs probe            # 三个后端的连通性
node cli.mjs search "查询词"   # 走完整回退链跑一次真实搜索
node cli.mjs status           # 看 profile 里 provider 指向
```

`probe` 和 `search` 直接打网络，不需要 dsh 在跑，是判断某个端点挂没挂最快的办法。

## 限制

用它之前先知道这些：

- **三家都是匿名额度**，没有任何配额保证。会限流、会改结构、会突然不认你。
- **不支持时间过滤**，`timeRange` 这类参数会被忽略。
- **不做相关性重排**，只按 URL 去重和截断，顺序来自后端。
- **Bing 是抓 HTML 解析的**，页面结构一变就断。而它是拉丁查询的第一顺位，所以这是最脆的一环。
- **Bing 会改写中文长查询**，所以中文查询不从它开始。
- **Exa 的匿名额度不可靠**，只作兜底。
- 单后端超时：Bing 8 秒 / Firecrawl 9 秒 / Exa 6 秒。全挂时最坏约 23 秒。
- 假定出网直连。走代理时需要在启动 dsh 的进程里设 `HTTPS_PROXY` 和 `NODE_USE_ENV_PROXY=1` —— Node 的 `fetch` 不读系统代理。

## 目录

```
index.js           provider 本体：回退链、语言路由、冷却
cordis.patch.yml   bundle 往 profile 里插的行
cli.mjs            probe / search / status
locale/            插件页标题与描述（中英）
docs/DETAIL.md     插件页显示的详情
tests/smoke.mjs    冒烟测试（仍会请求网络）
icon.svg           插件图标
```

## 参与

Issue 和 PR 都欢迎。加新后端时请附上**中文查询和英文查询都能返回相关结果**的证据 —— 光有 HTTP 200 不算数。早期草稿里有个后端返回 `200 OK`，查 "deepseek harness" 给出的是奥运秋千吊架。

## 许可

MIT
