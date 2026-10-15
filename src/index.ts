import { Hono } from 'hono'
import { jwtVerify, SignJWT } from 'jose'

type Env = {
  BUS_PROXY_URL: string
  JWT_SECRET: string
  PROXY_TOKEN: string
}

const app = new Hono<{ Bindings: Env }>()

// Magic byte signatures (minimal set)
const MAGIC: Record<string, Uint8Array> = {
  pe: new Uint8Array([0x4d, 0x5a]),
  elf: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
  wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
  apk: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // zip/apk
  dex: new Uint8Array([0x64, 0x65, 0x78, 0x0a]),
}

function detectMagic(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf)
  for (const [name, sig] of Object.entries(MAGIC)) {
    if (u8.length >= sig.length && sig.every((b, i) => u8[i] === b)) return name
  }
  // JS/JSON heuristic
  const head = new TextDecoder().decode(u8.slice(0, 64)).trimStart()
  if (head.startsWith('{') || head.startsWith('[') || head.startsWith('function') || head.startsWith('import')) return 'js'
  return 'unknown'
}

function shannonEntropy(buf: ArrayBuffer): number {
  const u8 = new Uint8Array(buf)
  if (u8.length === 0) return 0
  const counts = new Array(256).fill(0)
  for (const b of u8) counts[b]++
  let ent = 0
  const len = u8.length
  for (const c of counts) {
    if (c === 0) continue
    const p = c / len
    ent -= p * Math.log2(p)
  }
  return Math.round(ent * 1000) / 1000
}

function extractStrings(buf: ArrayBuffer, minLen = 6): { value: string; offset: number; kind?: string }[] {
  const u8 = new Uint8Array(buf)
  const results: { value: string; offset: number; kind?: string }[] = []
  let current = ''
  let start = 0

  const classify = (s: string): string | undefined => {
    if (/^[A-Za-z0-9_-]{20,}$/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)) return 'api_key_candidate'
    if (/https?:\/\/[^\s"']+/i.test(s)) return 'url'
    if (/map|tile|geo|cluster|bayut|dubizzle|propertyfinder/i.test(s)) return 'geo_or_portal'
    if (/Bearer |Authorization|x-api-key|api[_-]?key/i.test(s)) return 'auth_header'
    return undefined
  }

  for (let i = 0; i < u8.length; i++) {
    const c = u8[i]
    if (c >= 32 && c <= 126) {
      if (current.length === 0) start = i
      current += String.fromCharCode(c)
    } else {
      if (current.length >= minLen) {
        const kind = classify(current)
        results.push({ value: current, offset: start, kind })
      }
      current = ''
    }
  }
  if (current.length >= minLen) {
    results.push({ value: current, offset: start, kind: classify(current) })
  }
  // Cap to keep payload small
  return results.slice(0, 500)
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function publishEvent(env: Env, event: object) {
  const secret = new TextEncoder().encode(env.JWT_SECRET)
  const token = await new SignJWT({ sub: 'rea-worker', scope: 'publish' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(secret)

  const res = await fetch(`${env.BUS_PROXY_URL}/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Proxy-Token': env.PROXY_TOKEN,
    },
    body: JSON.stringify(event),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`bus publish failed: ${res.status} ${text}`)
  }
  return res.json()
}

app.get('/', (c) => c.json({ service: 'sahiixx-rea-worker', version: '0.1.0', status: 'ok' }))

app.post('/analyze', async (c) => {
  const env = c.env
  if (!env.JWT_SECRET || !env.PROXY_TOKEN) {
    return c.json({ error: 'secrets not configured' }, 500)
  }

  const contentType = c.req.header('content-type') || ''
  let buf: ArrayBuffer
  let sourceName = 'upload'

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData()
    const file = form.get('file') as File | null
    if (!file) return c.json({ error: 'missing file' }, 400)
    buf = await file.arrayBuffer()
    sourceName = file.name || 'upload'
  } else {
    buf = await c.req.arrayBuffer()
  }

  if (buf.byteLength === 0) return c.json({ error: 'empty body' }, 400)
  if (buf.byteLength > 8 * 1024 * 1024) return c.json({ error: 'max 8MB for edge triage' }, 413)

  const magic = detectMagic(buf)
  const entropy = shannonEntropy(buf)
  const strings = extractStrings(buf)
  const sha = await sha256(buf)

  const event = {
    type: 'rea.analysis.completed',
    source: 'sahiixx-rea-worker',
    timestamp: new Date().toISOString(),
    file: {
      name: sourceName,
      sha256: sha,
      size: buf.byteLength,
      magic,
      entropy,
    },
    strings,
    evidence_chain: [
      { step: 'magic', result: magic },
      { step: 'entropy', result: entropy },
      { step: 'strings', count: strings.length, candidates: strings.filter(s => s.kind).length },
    ],
    limitations: [
      'Edge triage only. No full disassembly or Ghidra.',
      'String extraction is ASCII only, min length 6, capped at 500.',
      'Full REA analysis (functions, pseudocode) stays local via Hermes/REA agents.',
    ],
  }

  try {
    await publishEvent(env, event)
  } catch (e: any) {
    // Still return the local analysis even if bus is down
    return c.json({ ...event, bus_error: e.message }, 200)
  }

  return c.json({
    ok: true,
    sha256: sha,
    magic,
    entropy,
    string_count: strings.length,
    key_candidates: strings.filter(s => s.kind === 'api_key_candidate' || s.kind === 'auth_header').length,
    published: true,
  })
})

export default app
