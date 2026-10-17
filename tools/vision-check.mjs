#!/usr/bin/env node
/**
 * Live image-input check — real network, real credential, real credit.
 *
 * The upstream catalog's `vision` tag is its only capability field, and it has
 * been observed wrong in both directions, so the plugin ships per-model
 * measurements instead (`MEASURED_VISION` in `src/catalog.ts`). This tool is how
 * those measurements are re-taken after an app update: it builds a PNG whose
 * three vertical stripe colors are drawn at random on every run, asks the model
 * to name them left to right, and scores the answer against what was generated.
 *
 * Self-verifying matters here: the gateway does not reject an image for a
 * text-only model. It drops the part and the model answers "我无法看到图片", so
 * no status code can settle the question.
 *
 *   node tools/vision-check.mjs                  # every visible catalog model
 *   node tools/vision-check.mjs --model <id>     # one model, repeatable
 *   node tools/vision-check.mjs --runs 2         # per model, to rule out a fluke
 *
 * One tiny completion per run at the model's own rate.
 */

import { deflateSync } from 'node:zlib'
import { ALL_VARIANTS, MEASURED_VISION, RaccoonCredentialStore, RaccoonUpstreamClient, resolveClientIdentity } from '../lib/index.js'

const args = process.argv.slice(2)
const modelFlag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const requested = args.reduce((acc, arg, index) => (arg === '--model' && args[index + 1] !== undefined ? [...acc, args[index + 1]] : acc), [])
const runs = Number(modelFlag('--runs') ?? 1)
const variant = ALL_VARIANTS[0]

/** Color name → RGB, and the single Chinese character that identifies it. */
const PALETTE = {
  红: [220, 30, 40],
  绿: [30, 190, 90],
  蓝: [40, 80, 235],
  黄: [240, 210, 40],
  紫: [150, 60, 200],
  橙: [245, 140, 30],
}
const NAMES = Object.keys(PALETTE)

/** Three distinct colors, in left-to-right order. */
function drawStripes() {
  const picked = []
  while (picked.length < 3) {
    const name = NAMES[Math.floor(Math.random() * NAMES.length)]
    if (!picked.includes(name)) picked.push(name)
  }
  return picked
}

function pngOf(colors) {
  const width = 96
  const height = 96
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = PALETTE[colors[Math.floor(x / (width / 3))]]
      row[1 + x * 3] = r
      row[2 + x * 3] = g
      row[3 + x * 3] = b
    }
    rows.push(row)
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf) => {
    let c = ~0
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8)
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Phrases that mean "the image never reached me", not "I chose not to answer". */
const BLIND_PHRASES = [
  '无法看到', '无法查看', '看不到', '没有看到', '没看到', '未看到', '不能看到', '无法处理', '不能处理', '无法识别图',
  '不支持图片', '没有图片', '没有收到图', '图片无法',
  'cannot see', 'can\'t see', 'unable to see', 'cannot view', 'no image', 'image is not',
  'cannot process this image', 'don\'t have multi-modal', 'do not have multi-modal',
]

/** Each stripe color, spelled the way a Chinese or an English answer may spell it. */
const COLOR_ALIASES = {
  红: ['红', 'red'],
  绿: ['绿', 'green'],
  蓝: ['蓝', 'blue'],
  黄: ['黄', 'yellow'],
  紫: ['紫', 'purple', 'violet'],
  橙: ['橙', 'orange'],
}

/**
 * Score one answer.
 *
 * `sees` requires the three colors named in the order they were drawn; a
 * text-only model would have to guess the ordered triple out of six colors to
 * reach the same verdict, which is why a run is decisive rather than suggestive.
 * Anything else stays `unclear`: absence is not proof of blindness, and a tool
 * that guesses here is what produced the bad upstream tag in the first place.
 */
function score(answer, colors) {
  const text = answer.toLowerCase()
  if (BLIND_PHRASES.some(phrase => text.includes(phrase.toLowerCase()))) return 'blind'
  let cursor = -1
  for (const color of colors) {
    let next = -1
    for (const alias of COLOR_ALIASES[color]) {
      const at = text.indexOf(alias.toLowerCase(), cursor + 1)
      if (at !== -1 && (next === -1 || at < next)) next = at
    }
    if (next === -1) return 'unclear'
    cursor = next
  }
  return 'sees'
}

const client = new RaccoonUpstreamClient({ variant, identity: resolveClientIdentity })
const store = new RaccoonCredentialStore({ variant, refresh: token => client.refresh(token) })
const credential = await store.resolve()
const catalog = await client.fetchCatalog(credential.accessToken)
const targets = requested.length > 0
  ? catalog.models.filter(model => requested.includes(model.id))
  : catalog.models.filter(model => model.visible)
if (targets.length === 0) {
  console.error(requested.length > 0 ? `no catalog row matches: ${requested.join(', ')}` : 'catalog has no visible models')
  process.exit(1)
}

console.log(`probing ${targets.length} model(s), ${runs} run(s) each — one tiny completion per run\n`)
console.log('model'.padEnd(32), 'tag'.padEnd(6), 'measured'.padEnd(10), 'verdict'.padEnd(10), 'notes')
for (const model of targets) {
  const tagVision = model.tags.includes('vision')
  const measured = Object.hasOwn(MEASURED_VISION, model.id) ? MEASURED_VISION[model.id] : undefined
  const seen = []
  const notes = []
  for (let run = 0; run < runs; run += 1) {
    const colors = drawStripes()
    const png = pngOf(colors)
    let response
    try {
      response = await fetch(`${variant.llmBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${credential.accessToken}`,
          'X-Raccoon-Language': 'zh',
          'X-Client-Platform': 'desktop',
        },
        body: JSON.stringify({
          model: model.id,
          stream: false,
          max_tokens: 800,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '这张图里有三条竖直色块。请只按从左到右顺序说出它们的颜色，用中文，不要解释。' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
            ],
          }],
        }),
      })
    } catch (error) {
      seen.push('error')
      notes.push(`传输失败 ${String(error).slice(0, 80)}`)
      continue
    }
    const text = await response.text()
    if (!response.ok) {
      seen.push('error')
      notes.push(`HTTP ${response.status} ${text.slice(0, 80)}`)
      continue
    }
    let message
    try {
      message = JSON.parse(text)?.choices?.[0]?.message ?? {}
    } catch {
      seen.push('error')
      notes.push(`响应不是 JSON：${text.slice(0, 60)}`)
      continue
    }
    // A model that spent the whole budget reasoning can return an empty `content`;
    // the thinking names the colors just as well, so either text is evidence.
    const answerText = String(message['content'] ?? '') || String(message['reasoning_content'] ?? '')
    seen.push(score(answerText, colors))
    notes.push(`${colors.join('')}→${answerText.replace(/\s+/gu, ' ').slice(0, 24) || '(空)'}`)
  }
  const decided = seen.filter(entry => entry !== 'error')
  const answer = decided.includes('sees')
    ? 'reads images'
    : decided.length === 0
      ? 'unreachable'
      : decided.every(entry => entry === 'blind')
        ? 'text only'
        : 'unclear'
  const agrees = (answer === 'reads images') === tagVision
  console.log(
    model.id.padEnd(32),
    (tagVision ? 'yes' : 'no').padEnd(6),
    (measured === undefined ? '-' : measured ? 'yes' : 'no').padEnd(10),
    (answer + (agrees ? '' : ' ≠tag')).padEnd(10),
    notes.join(' | '),
  )
}
