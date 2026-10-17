#!/usr/bin/env node
/**
 * Live upstream check — real network, real credential, real credit.
 *
 * Not part of the plugin runtime: it exists so the protocol facts in
 * `docs/upstream-protocol.md` can be re-verified against the gateway after an
 * app update, in one command, without opening a DSH session. It spends one tiny
 * completion, so it is opt-in by invocation.
 *
 *   node tools/live-check.mjs [--model <id>] [--no-chat]
 */

import { RaccoonCredentialStore } from '../lib/index.js'
import { ALL_VARIANTS } from '../lib/index.js'
import { RaccoonUpstreamClient } from '../lib/index.js'
import { resolveClientIdentity } from '../lib/index.js'

const variant = ALL_VARIANTS[0]
const args = process.argv.slice(2)
const noChat = args.includes('--no-chat')
const modelFlag = args.indexOf('--model')
const requestedModel = modelFlag === -1 ? undefined : args[modelFlag + 1]

const client = new RaccoonUpstreamClient({ variant, identity: resolveClientIdentity })
const store = new RaccoonCredentialStore({ variant, refresh: token => client.refresh(token) })

const credential = await store.resolve()
const summary = await store.status()
console.log(`credential  source=${summary.source} expires=${new Date(summary.expiresAtMs).toISOString()} account=${credential.accountId}`)

const catalog = await client.fetchCatalog(credential.accessToken)
console.log(`catalog     ${catalog.models.length} models, default=${catalog.defaultModelId}`)
for (const model of catalog.models) {
  const rate = model.billingEffectiveMultiplier ?? model.billingMultiplier
  console.log(`  - ${model.id.padEnd(34)} ${model.label.padEnd(26)} ctx=${model.contextWindow ?? '?'} max=${model.maxTokens ?? '?'} rate=${rate ?? '?'} tags=${model.tags.join(',') || '-'}${model.billingDiscounts.length ? ` promos=${model.billingDiscounts.map(d => d.name).join('/')}` : ''}`)
}

const points = await client.fetchBalance(credential.accessToken).catch(error => ({ error: String(error).slice(0, 160) }))
console.log(`points      ${JSON.stringify(points)}`)

if (noChat) process.exit(0)
const model = requestedModel ?? catalog.defaultModelId ?? catalog.models[0]?.id
if (model === undefined) {
  console.error('no model to call')
  process.exit(1)
}
const started = Date.now()
const stream = await client.chatStream(model === undefined ? '' : credential.accessToken, {
  model,
  stream: true,
  max_tokens: 16,
  messages: [{ role: 'user', content: '只回复两个字：收到' }],
})
if (stream.ok === false) {
  console.error(`chat        FAILED kind=${stream.kind} status=${stream.status}: ${stream.message.slice(0, 300)}`)
  process.exit(1)
}
const reader = stream.body.getReader()
const decoder = new TextDecoder()
let text = ''
let events = 0
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  const chunk = decoder.decode(value, { stream: true })
  events += (chunk.match(/^data:/gmu) ?? []).length
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload)
      const delta = parsed.choices?.[0]?.delta?.content ?? ''
      text += delta
    } catch {
      // A partial frame across chunk boundaries is normal; the next read continues it.
    }
  }
}
console.log(`chat        model=${model} sse-events=${events} ms=${Date.now() - started} text=${JSON.stringify(text.slice(0, 120))}`)
