#!/usr/bin/env node
/**
 * 运维入口：体检三个免 key 后端、跑一次真实搜索、看当前 provider 指向。
 *
 *   node backend/cli.mjs probe           # 三家连通性（状态码 / 耗时 / 响应体大小）
 *   node backend/cli.mjs search "查询词"  # 走完整回退链，打印前几条结果
 *   node backend/cli.mjs status          # 读 profile 的 cordis.patch.yml，看 searchProvider 指向
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createProvider } from './index.js'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'

const ENDPOINTS = [
  {
    id: 'bing',
    method: 'GET',
    url: 'https://www.bing.com/search?q=ping&count=3',
    headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  },
  {
    id: 'firecrawl',
    method: 'POST',
    url: 'https://api.firecrawl.dev/v2/search',
    body: { query: 'ping', limit: 1 },
    headers: {},
  },
  {
    id: 'exa',
    method: 'POST',
    url: 'https://mcp.exa.ai/mcp',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query: 'ping', numResults: 1 } } },
    headers: { accept: 'application/json, text/event-stream' },
  },
]

async function probe() {
  console.log('渠道体检（直连，不带代理）\n')
  for (const endpoint of ENDPOINTS) {
    const started = Date.now()
    try {
      const response = await fetch(endpoint.url, {
        method: endpoint.method,
        headers: {
          'user-agent': USER_AGENT,
          ...endpoint.method === 'POST' ? { 'content-type': 'application/json' } : {},
          ...endpoint.headers,
        },
        ...endpoint.body === undefined ? {} : { body: JSON.stringify(endpoint.body) },
        signal: AbortSignal.timeout(15_000),
      })
      const text = await response.text()
      const verdict = response.ok ? '可用' : '异常'
      console.log(`  ${endpoint.id.padEnd(10)} HTTP ${String(response.status).padEnd(4)} ${verdict.padEnd(4)} ${String(Date.now() - started).padStart(6)}ms  ${text.length}B`)
    } catch (error) {
      console.log(`  ${endpoint.id.padEnd(10)} 连接失败  ${String(Date.now() - started).padStart(6)}ms  ${error.message}`)
    }
  }
}

async function search(query) {
  if (typeof query !== 'string' || query.trim() === '') {
    console.log('用法: node backend/cli.mjs search "查询词"')
    process.exitCode = 1
    return
  }
  const provider = createProvider()
  const started = Date.now()
  try {
    const result = await provider.search({ query, maxResults: 8 })
    console.log(`${result.sources.length} 条 / ${Date.now() - started}ms ${result.content ?? ''}\n`)
    for (const [index, source] of result.sources.entries()) {
      console.log(`${index + 1}. ${source.title ?? '(无标题)'}`)
      console.log(`   ${source.url}`)
      if (source.snippet) console.log(`   ${source.snippet.slice(0, 100)}`)
    }
  } catch (error) {
    console.log(`失败 / ${Date.now() - started}ms: ${error.message}`)
    process.exitCode = 1
  }
}

async function status() {
  const profile = process.env.DSH_PROFILE ?? 'desktop'
  const file = join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
  try {
    const yaml = await readFile(file, 'utf8')
    const section = yaml.split(/^- id: web$/m)[1]?.split(/^- (?:id|insert):/m)[0] ?? ''
    const provider = /searchProvider:\s*(\S+)/.exec(section)?.[1]
    const fetcher = /fetchProvider:\s*(\S+)/.exec(section)?.[1]
    console.log(`profile: ${profile}`)
    console.log(`  searchProvider: ${provider ?? '(未配置 → 出厂默认)'}`)
    console.log(`  fetchProvider:  ${fetcher ?? '(未配置 → http)'}`)
  } catch (error) {
    console.log(`读不到 ${file}: ${error.message}`)
    process.exitCode = 1
  }
}

const [command, ...rest] = process.argv.slice(2)
const handlers = { probe, search: () => search(rest[0]), status }
const handler = handlers[command]
if (handler === undefined) {
  console.log('用法: node backend/cli.mjs <probe|search|status> [参数]')
  process.exitCode = 1
} else {
  await handler()
}
