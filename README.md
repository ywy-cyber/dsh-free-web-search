# dsh-free-web-search

**Keyless web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).** No API key, no billing, no proxy — three public endpoints behind one search provider with language-aware failover.

[中文说明](README.zh.md)

---

## Why

dsh ships a search provider that needs a DeepSeek API key. That is a problem in two common setups:

- **No official key.** The user runs DSH against a third-party model gateway, so `web_search` cannot authenticate and simply fails.
- **Official key, third-party model.** The search still goes through DeepSeek's own endpoint, so the account is billed even though the chat runs elsewhere.

This plugin replaces the search side of `ctx.web` with providers that need no credentials at all. It does **not** touch `web_fetch` — fetching keeps whatever provider you already use.

## How it searches

One provider, id `free`. Per request it walks a short chain and returns the first non-empty result set. Which backend leads depends on the shape of the query, because they fail in different ways:

| Query | Order | Why |
|---|---|---|
| Single token, non-CJK (`vllm`) | Bing → Firecrawl → Exa | Bing answers in ~0.3 s and a one-token query has nothing to collapse |
| Everything else | Firecrawl → Exa → Bing | Bing collapses multi-token queries to their first token — see below |

| Backend | Endpoint | Notes |
|---|---|---|
| Bing | `https://www.bing.com/search` (HTML) | Fastest, but only safe for one-token queries |
| Firecrawl | `https://api.firecrawl.dev/v2/search` | Most reliable overall, 1–6 s, handles Chinese and multi-word queries |
| Exa | `https://mcp.exa.ai/mcp` (anonymous MCP) | Best snippets, but the anonymous quota dies hard and often |

A backend that throws is parked for 3 minutes, in memory and in `~/.dsh/web-search-free.state.json`, so a rate-limited endpoint is not paid for on every search. If every backend is parked, the parking lot is cleared and one real round is attempted — search never fails on stale bookkeeping.

When a fallback happened, the result carries `(free search fell back to <backend>)` so you can tell which endpoint actually served.

## Install

Requires dsh with the `ctx.web` seam (`@deepseek-ai/dsh-web`). Node 20+ for the CLI.

**From a local checkout:**

```sh
git clone https://github.com/ywy-cyber/dsh-free-web-search.git
dsh plugin --profile <your-profile> add ./dsh-free-web-search
```

Or, inside DSH, install the directory through **Plugins → Add plugin**.

**Restart DSH afterwards.** The provider is loaded as an ES module and is not hot-replaced.

## What it changes in your profile

The bundle's patch inserts one row and points the web seam at it:

```yaml
- insert:
    - id: web-search-free
      name: 'dsh-free-web-search'
- id: web
  config:
    searchProvider: free
    fetchProvider: http
```

The `- id: web` override replaces the **whole** config of that row, which is why both fields are listed. `fetchProvider: http` is the shipped default — search changes, fetching does not.

To go back to the stock provider, remove this bundle; `searchProvider` becomes unset and dsh falls back to its default.

> If you also run another plugin that registers a fetch provider, set `fetchProvider` to that plugin's id here instead of `http`, otherwise this patch will override its choice.

## CLI

```sh
node cli.mjs probe            # connectivity of the three backends
node cli.mjs search "query"   # run one real search through the full chain
node cli.mjs status           # which provider the profile points at
```

`probe` and `search` talk to the network directly and do not need dsh running, which makes them the quickest way to tell whether an endpoint is down.

## Limitations

Be aware of these before relying on it:

- **All three backends are anonymous tiers.** No quota is guaranteed. They rate-limit, they change response shapes, and they can start refusing you without notice.
- **No time filtering.** `timeRange`-style parameters are ignored.
- **No relevance re-ranking.** Results are deduplicated by URL and truncated; order comes from the backend.
- **Bing results are scraped from HTML.** A layout change breaks the parser.
- **Bing collapses multi-token queries to their first token.** Ask it `deepseek harness plugin development` and you get DeepSeek's homepage plus look-alike domains; a long Chinese query collapses to a single character. That is why it only leads for one-token queries. DeepSeek's own search API behaves the same way — the two return nearly identical result sets.
- **Exa's anonymous quota is unreliable.** It is a last resort, not a primary.
- Per-backend deadline: Bing 8 s, Firecrawl 9 s, Exa 6 s. Worst case with everything failing is about 23 s.
- Direct outbound access is assumed. Behind a proxy, set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` in the process that runs dsh — Node's `fetch` does not read the system proxy.

## Project layout

```
index.js           the provider: chain, language routing, cooldowns
cordis.patch.yml   what the bundle inserts into the profile
cli.mjs            probe / search / status
locale/            plugin-page title and description (en, zh)
docs/DETAIL.md     the page shown in Plugins
tests/smoke.mjs    offline-ish smoke test (still hits the network)
icon.svg           plugin icon
```

## Contributing

Issues and pull requests are welcome. If you add a backend, include the evidence that it actually returns relevant results for both a Chinese and a Latin query — an HTTP 200 means nothing on its own. One backend in an earlier draft answered `200 OK` and returned Olympic trapeze harnesses for "deepseek harness".

## License

MIT
