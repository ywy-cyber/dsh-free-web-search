/** Smoke test for the free search provider, run outside DSH: node tmp/smoke.mjs */
import { createProvider } from '../index.js'

const provider = createProvider()
const cases = ['DeepSeek Harness', '大模型 推理加速 方案']

for (const query of cases) {
  const started = Date.now()
  try {
    const result = await provider.search({ query, maxResults: 5 })
    console.log(`\n[${query}] ${result.sources.length} 条 / ${Date.now() - started}ms ${result.content ?? ''}`)
    for (const source of result.sources.slice(0, 3)) {
      console.log(`  - ${(source.title ?? '(无标题)').slice(0, 60)}`)
      console.log(`    ${source.url}`)
      if (source.snippet) console.log(`    ${source.snippet.slice(0, 80)}`)
    }
  } catch (error) {
    console.log(`\n[${query}] 失败 / ${Date.now() - started}ms: ${error.message}`)
  }
}
