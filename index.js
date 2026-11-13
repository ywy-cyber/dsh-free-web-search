/**
 * Free web-search provider for the DeepSeek Harness web seam (`ctx.web`).
 *
 * Registers one search provider id `free` that walks a keyless chain and returns
 * the first non-empty result set:
 *
 *   1. Bing       https://www.bing.com/search        (HTML SERP, no key, fastest here)
 *   2. Firecrawl  https://api.firecrawl.dev/v2/search (anonymous tier, stable JSON)
 *   3. Exa        https://mcp.exa.ai/mcp              (anonymous MCP, richest snippets, hardest rate limits)
 *
 * No API keys, no dependencies, no proxy. A failing backend falls through to the
 * next one and is parked for a few minutes — in memory and in a small state file,
 * so a restart does not pay the same timeout again.
 *
 * @module @local/dsh-web-search-free
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-free'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Registry id the profile's `web.searchProvider` selects. */
export const PROVIDER_ID = 'free'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'

const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8'

/** How long a backend that threw is skipped before it is worth another try. */
const COOLDOWN_MS = 3 * 60 * 1000

/** Cooldown memory that survives a DSH restart. Best effort: an unwritable file just means memory only. */
const STATE_FILE = join(homedir(), '.dsh', 'web-search-free.state.json')

/** backend id → epoch ms until which it is skipped. Empty results never park a backend. */
const coolingUntil = new Map(loadState())

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    const now = Date.now()
    return Object.entries(parsed).filter(([, until]) => typeof until === 'number' && until > now)
  } catch {
    return []
  }
}

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(coolingUntil)), 'utf8')
  } catch {
    // A read-only or missing home is not worth failing a search over.
  }
}

/** Collapse whitespace and cut by code point (never through a surrogate pair). */
function collapse(text, limit = 300) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  const chars = [...flat]
  return chars.length <= limit ? flat : `${chars.slice(0, limit).join('')}…`
}

/** Strip tags and collapse whitespace. */
function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
}

/** Decode the numeric and common named entities Bing puts in titles and snippets. */
function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => codePoint(parseInt(hex, 16), match))
    .replace(/&#(\d+);/g, (match, dec) => codePoint(Number(dec), match))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

function codePoint(value, fallback) {
  try {
    return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback
  } catch {
    return fallback
  }
}

/** Merge an outer cancellation signal with a per-backend deadline. */
function withTimeout(signal, ms) {
  const deadline = AbortSignal.timeout(ms)
  if (signal === undefined) return deadline
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : deadline
}

/** POST JSON and return the raw body; non-2xx becomes a thrown Error with a body excerpt. */
async function postJson(url, body, signal, timeoutMs, extraHeaders = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: withTimeout(signal, timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${collapse(text, 160)}`)
  }
  return text
}

/** Parse JSON without throwing. */
function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Pull the first JSON payload out of a Server-Sent-Events body. */
function firstSsePayload(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (raw === '' || raw === '[DONE]') continue
    try {
      return JSON.parse(raw)
    } catch {
      // A non-JSON data line is not our payload; keep looking.
    }
  }
  return undefined
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/**
 * Bing splits CJK queries on whitespace and then matches single characters, so
 * `大模型 推理加速 方案` comes back as pages about the character 大. Drop only the
 * spaces between two CJK characters; spaces around Latin words stay.
 */
function bingQuery(query) {
  return CJK.test(query) ? query.replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '') : query
}

/** Mine a wrapping `bing.com/ck/a?...&u=a1<base64url>` redirect back to the real target. */
function unwrapBingUrl(url) {
  try {
    const parsed = new URL(url)
    if (!/(^|\.)bing\.com$/.test(parsed.hostname)) return url
    const raw = parsed.searchParams.get('u')
    if (raw === null) return url
    const base64 = raw.startsWith('a1') ? raw.slice(2) : raw
    const decoded = Buffer.from(base64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return /^https?:\/\//.test(decoded) ? decoded : url
  } catch {
    return url
  }
}

/** Parse a Bing result page: `li.b_algo` blocks carrying an `h2 > a` and a `p` caption. */
function parseBingHtml(html, limit) {
  const sources = []
  for (const block of String(html).split('<li class="b_algo"').slice(1)) {
    if (sources.length >= limit) break
    const anchor = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (anchor === null) continue
    const url = unwrapBingUrl(anchor[1])
    if (!/^https?:\/\//.test(url)) continue
    const title = decodeEntities(stripTags(anchor[2]))
    const caption = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? ''
    const snippet = decodeEntities(stripTags(caption))
    sources.push({
      url,
      ...title !== '' ? { title } : {},
      ...snippet !== '' ? { snippet: collapse(snippet) } : {},
    })
  }
  return sources
}

/** Keyless Bing HTML SERP. */
async function searchBing(query, limit, signal, timeoutMs) {
  const target = `https://www.bing.com/search?q=${encodeURIComponent(bingQuery(query))}&count=${Math.max(limit * 2, 10)}`
  const response = await fetch(target, {
    headers: { 'user-agent': USER_AGENT, 'accept-language': ACCEPT_LANGUAGE },
    redirect: 'follow',
    signal: withTimeout(signal, timeoutMs),
  })
  const html = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const sources = parseBingHtml(html, limit)
  if (sources.length === 0 && /captcha|unusual traffic|verify you are human/i.test(html)) {
    throw new Error('bot check page instead of results')
  }
  return sources
}

/** Keyless Firecrawl web search. */
async function searchFirecrawl(query, limit, signal, timeoutMs) {
  const payload = safeJson(await postJson('https://api.firecrawl.dev/v2/search', { query, limit }, signal, timeoutMs))
  const hits = payload?.data?.web
  if (!Array.isArray(hits)) return []
  return hits.slice(0, limit).flatMap((hit) => {
    if (typeof hit?.url !== 'string') return []
    const description = typeof hit.description === 'string' ? hit.description : ''
    return [{
      url: hit.url,
      ...typeof hit.title === 'string' && hit.title !== '' ? { title: hit.title } : {},
      ...description !== '' ? { snippet: collapse(description) } : {},
    }]
  })
}

/** Parse Exa's `Title:/URL:/Highlights:` blocks into sources. */
function parseExaText(text) {
  const sources = []
  for (const chunk of String(text).split(/\n(?=Title:\s)/)) {
    const url = /^URL:\s*(\S+)/m.exec(chunk)?.[1]
    if (url === undefined) continue
    const rawTitle = /^Title:\s*(.+)$/m.exec(chunk)?.[1]?.trim()
    const highlight = chunk.split(/^Highlights:\s*$/m)[1] ?? ''
    sources.push({
      url,
      ...rawTitle !== undefined && rawTitle !== '' && rawTitle !== 'N/A' ? { title: rawTitle } : {},
      ...highlight.trim() !== '' ? { snippet: collapse(highlight) } : {},
    })
  }
  return sources
}

/** Keyless Exa over its public MCP endpoint; the tool answers with one text block. */
async function searchExa(query, limit, signal, timeoutMs) {
  const raw = await postJson(
    'https://mcp.exa.ai/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query, numResults: limit } },
    },
    signal,
    timeoutMs,
    { accept: 'application/json, text/event-stream' },
  )
  const payload = raw.trimStart().startsWith('{') ? safeJson(raw) : firstSsePayload(raw)
  const blocks = payload?.result?.content
  const text = Array.isArray(blocks)
    ? blocks.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n')
    : ''
  return parseExaText(text)
}

/** Backends, each with its own deadline. */
const BING = { id: 'bing', run: searchBing, timeoutMs: 8_000 }
const FIRECRAWL = { id: 'firecrawl', run: searchFirecrawl, timeoutMs: 9_000 }
const EXA = { id: 'exa', run: searchExa, timeoutMs: 6_000 }

/**
 * Bing collapses any multi-token query down to its first meaningful token and
 * then answers for that token alone: `deepseek harness plugin development` comes
 * back as DeepSeek's homepage plus look-alike domains, and the same happens to
 * long Chinese queries (they resolve to a single character). It is only safe
 * when the query *is* one token — there is nothing to collapse.
 *
 * So the chain leads with Bing only for a single token outside CJK, which is
 * also the case where its few-hundred-millisecond answer is worth having.
 * Everything else starts at Firecrawl, whose own index does not rewrite the
 * query this way.
 */
function bingCanAnswerAlone(query) {
  const text = String(query).trim()
  if (text === '' || CJK.test(text)) return false
  return text.split(/\s+/u).filter(Boolean).length <= 1
}

function chainFor(query) {
  return bingCanAnswerAlone(query) ? [BING, FIRECRAWL, EXA] : [FIRECRAWL, EXA, BING]
}

/** Drop repeated URLs while preserving the first occurrence. */
function dedupe(sources) {
  const seen = new Set()
  const out = []
  for (const source of sources) {
    if (seen.has(source.url)) continue
    seen.add(source.url)
    out.push(source)
  }
  return out
}

/**
 * Walk the backend list once.
 * @param respectCooldown - when true, skip backends parked by an earlier failure.
 * @returns the first non-empty source list, plus which backend produced it.
 */
async function runChain(query, limit, signal, respectCooldown, backends) {
  const failures = []
  let skipped = 0
  for (const [index, backend] of backends.entries()) {
    if (signal?.aborted === true) throw new Error('free search: aborted')
    const until = coolingUntil.get(backend.id) ?? 0
    if (respectCooldown && until > Date.now()) {
      skipped += 1
      failures.push(`${backend.id}: cooling down`)
      continue
    }
    try {
      const sources = dedupe(await backend.run(query, limit, signal, backend.timeoutMs)).slice(0, limit)
      if (sources.length > 0) {
        if (coolingUntil.delete(backend.id)) saveState()
        return { sources, backendId: backend.id, index, failures, skipped }
      }
      failures.push(`${backend.id}: 0 results`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      coolingUntil.set(backend.id, Date.now() + COOLDOWN_MS)
      saveState()
      failures.push(`${backend.id}: ${message}`)
    }
  }
  return { sources: [], backendId: undefined, index: -1, failures, skipped }
}

/**
 * The provider registered into `ctx.web`. `available()` stays true: none of the
 * backends needs a credential, so a configuration check could only hide a
 * provider that might still succeed.
 */
function createProvider() {
  return {
    id: PROVIDER_ID,
    title: 'Free search (Bing / Firecrawl / Exa)',
    description: {
      en: 'Keyless public endpoints with automatic failover. No API key; rate limits apply.',
      zh: '免 key 的公开接口，失败自动换下一个；有限流，无需任何 API key。',
    },
    available: () => true,
    async search(request, signal) {
      const query = request?.query
      if (typeof query !== 'string' || query.trim() === '') {
        throw new Error('free search: empty query')
      }
      const limit = Number.isInteger(request.maxResults) && request.maxResults > 0 ? request.maxResults : 8
      const backends = chainFor(query)

      let attempt = await runChain(query, limit, signal, true, backends)
      // Every backend was cooling down: forget the parking lot and pay for one
      // real round rather than failing a search on stale bookkeeping.
      if (attempt.sources.length === 0 && attempt.skipped === backends.length) {
        coolingUntil.clear()
        saveState()
        attempt = await runChain(query, limit, signal, false, backends)
      }
      if (attempt.sources.length === 0) {
        throw new Error(`free search: every backend failed — ${attempt.failures.join('; ')}`)
      }
      return {
        sources: attempt.sources,
        truncated: false,
        // Only name the backend when it is not the first choice, so the common
        // path adds no noise to the model's context.
        ...attempt.index === 0 ? {} : { content: `(free search fell back to ${attempt.backendId})` },
      }
    },
  }
}

/**
 * Register the free search provider with `ctx.web`. Registration is bound to the
 * plugin fiber and is disposed with it.
 */
export function apply(ctx) {
  ctx.web.registerSearchProvider(createProvider())
  ctx.logger?.info?.('web-search-free: registered search provider "free" (single-token: bing → firecrawl → exa; otherwise firecrawl → exa → bing)')
}

export { createProvider }
