#!/usr/bin/env node
/**
 * End-to-end live check through the *harness seam*, not the gateway alone.
 *
 * `live-check.mjs` proves the upstream answers. This proves the assembled
 * provider answers: the real `PiAiAdapter` with the real model descriptors built
 * from the live catalog, driving the real loopback shim, streaming real chunks
 * back. That is the only way to catch a wiring mistake that both unit tests
 * (stubbed fetch) and the gateway probe (bypassing pi-ai) would miss — a wrong
 * base URL, an unmapped token, a thinking delta nobody assembled.
 *
 * It spends credit. Two completions, both tiny.
 *
 *   node tools/live-stream-check.mjs [--model <id>] [--no-tools]
 */

import {
  ALL_VARIANTS,
  RaccoonCredentialStore,
  RaccoonUpstreamClient,
  badgeRows,
  createRaccoonAdapter,
  RaccoonCatalog,
  startRaccoonShim,
} from '../lib/index.js'

const variant = ALL_VARIANTS[0]
const args = process.argv.slice(2)
const withTools = !args.includes('--no-tools')
const modelFlag = args.indexOf('--model')
const requested = modelFlag === -1 ? undefined : args[modelFlag + 1]

const client = new RaccoonUpstreamClient({ variant })
const store = new RaccoonCredentialStore({ variant, refresh: token => client.refresh(token) })
const catalog = new RaccoonCatalog()

const credential = await store.resolve()
const document = await client.fetchCatalog(credential.accessToken)
catalog.set(document)
console.log(`catalog     ${catalog.current().length} models (source=live)`)
console.log('picker rows ')
for (const row of badgeRows(catalog)) {
  console.log(`  - ${row.name.padEnd(40)} ${row.credits ?? '价格未知'}${(row.badges ?? []).length ? ` [${row.badges.join(',')}]` : ''} vision=${row.vision}`)
}

const shim = await startRaccoonShim({
  accessToken: async () => (await store.resolve()).accessToken,
  upstream: client,
  catalog: () => catalog,
})
const adapter = createRaccoonAdapter({
  providerId: variant.id,
  displayName: variant.displayName,
  shim,
  catalog,
  observe: () => undefined,
}).adapter

const model = requested ?? 'sn-glm-5-3-flash'

/** Drain one adapter stream and summarize what came out. */
async function stream(label, options) {
  const counts = new Map()
  const text = []
  const thinking = []
  const toolCalls = []
  const toolBlocks = []
  let usage = null
  let finish = null
  const started = Date.now()
  for await (const chunk of adapter.stream(options)) {
    const kind = chunk.type ?? 'unknown'
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    if (kind === 'text-delta') text.push(chunk.delta ?? chunk.text ?? '')
    if (kind === 'reasoning-delta') thinking.push(chunk.delta ?? chunk.text ?? '')
    if (kind === 'tool-call-delta') toolCalls.push(chunk)
    if (kind === 'block-end' && (chunk.block?.type === 'tool-call' || chunk.block?.type === 'tool_use')) toolBlocks.push(chunk.block)
    if (kind === 'usage') usage = chunk.usage ?? chunk
    if (kind === 'finish') finish = chunk.reason ?? chunk
  }
  console.log(`\n${label}: ${Date.now() - started}ms  ${[...counts.entries()].map(([k, v]) => `${k}×${v}`).join(' ')}`)
  if (thinking.length > 0) console.log(`  thinking  ${JSON.stringify(thinking.join('').slice(0, 80))}`)
  if (text.length > 0) console.log(`  text      ${JSON.stringify(text.join('').slice(0, 120))}`)
  for (const call of toolCalls.slice(0, 3)) {
    console.log(`  tool-call id=${call.id} name=${JSON.stringify(call.name)} argsDelta=${JSON.stringify(String(call.argumentsDelta ?? '').slice(0, 160))}`)
  }
  for (const block of toolBlocks) {
    console.log(`  assembled ${JSON.stringify(block).slice(0, 220)}`)
  }
  if (usage !== null) console.log(`  usage     ${JSON.stringify(usage).slice(0, 220)}`)
  console.log(`  finish    ${JSON.stringify(finish).slice(0, 120)}`)
}

await stream('plain chat', {
  provider: variant.id,
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话说明你是谁' }] }],
})

if (withTools) {
  await stream('tool call', {
    provider: variant.id,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: '请把 2026 年 9 月 16 日换算成 Unix 时间戳，必须调用工具完成。' }] }],
    tools: [{
      name: 'date_to_epoch',
      description: 'Convert a YYYY-MM-DD date to a Unix timestamp in seconds.',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: 'ISO date, YYYY-MM-DD' } },
        required: ['date'],
      },
    }],
  })
}

await shim.stop()
console.log('\nshim        stopped')
