import type { EngineInterface, PluginOptions, Register } from 'claude-code'

// cache-warmer: a prompt-cache indicator plus a bounded keepalive for INTERACTIVE
// Claude Code sessions.
//
// Indicator (under the prompt): cache ● 1h ████░░ 38m left · hit 91% · keepalive 1h42m ↻2
//                               cache ○ cold · next message re-caches ~82k tokens
//
// Keepalive: one $.model.fork (tool-less, over the session's own transcript, so the
// API serves the exact main-thread prefix from its cache) shortly before the cache
// TTL lapses. Nothing is appended to the transcript; no proxy, no env changes, no
// credentials are touched.
//
//   /warm [2h|90m]       keep this session warm for a window (max 8h)
//   /warm off | on       stop for this session / undo that
//   /warm auto on|off    keep every session warm after each reply (persists; 1h TTL only)
//   /warm status         details
//   /warm test           one ping now, report what the cache served
//
// Never pings: in a non-interactive session (claude -p, SDK hosts); outside a
// window; while a turn runs; once the cache is already cold; when
// CACHE_WARMER_DISABLE=1 or ~/.claude/cache-warmer-off exists. A ping that reads
// nothing, or writes more than 10% of what it read, stops it for the session.

const MIN = 60_000
const HOUR = 60 * MIN
const MAX_WINDOW = 8 * HOUR
const TICK = 30_000
const STALE = 24 * HOUR
const PING_PROMPT = 'Reply with the single word: ok'

type TtlSource = 'config' | 'learned' | 'guess'
type Saved = {
  until: number // keepalive window end (0 = none)
  last: number // when the main thread last got a response
  pings: number
  optOut: boolean
  ctx: number // context tokens the next request re-sends
  read: number // cache-read tokens over the session's own turns
  total: number // all input tokens over the session's own turns
  seen: number
}
const EMPTY: Saved = { until: 0, last: 0, pings: 0, optOut: false, ctx: 0, read: 0, total: 0, seen: 0 }

// Module state: a reload resets these; the session record comes back from $.store.
let isInteractive = false
let isPinging = false
let sid = ''
let s: Saved = { ...EMPTY }
let ttl = HOUR
let ttlSource: TtlSource = 'guess'
let autoOverride: boolean | undefined
let opts = { auto: false, autoWindow: 2 * HOUR, indicator: true }
let submittedAt = 0
const running = new Set<string>()

// ---- pure helpers ----------------------------------------------------------

const fmt = (ms: number) => {
  const m = Math.max(0, Math.round(ms / MIN))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}
const fmtLeft = (ms: number) => (ms >= MIN ? `${Math.floor(ms / MIN)}m` : `${Math.max(0, Math.floor(ms / 1000))}s`)
const parseWindow = (arg: string): number | undefined => {
  const m = /^(\d+)\s*(m|h)$/i.exec(arg.trim())
  if (!m) return undefined
  return Number(m[1]) * (m[2]?.toLowerCase() === 'h' ? HOUR : MIN)
}
const lead = () => Math.min(5 * MIN, Math.floor(ttl / 5))
const isAuto = () => autoOverride ?? opts.auto
const ttlLabel = () => `${ttlSource === 'guess' ? '~' : ''}${ttl >= HOUR ? '1h' : '5m'}`
const bar = (frac: number) => {
  const n = Math.max(0, Math.min(6, Math.round(frac * 6)))
  return '█'.repeat(n) + '░'.repeat(6 - n)
}

function readOptions(o: PluginOptions) {
  const win = typeof o.autoWindowMinutes === 'number' ? o.autoWindowMinutes : 120
  opts = {
    auto: o.auto === true,
    autoWindow: Math.min(MAX_WINDOW, Math.max(10, win) * MIN),
    indicator: o.indicator !== false,
  }
}

function indicatorText(now: number): string | undefined {
  const keep = s.until > now ? `keepalive ${fmt(s.until - now)} ↻${s.pings}` : ''
  if (!opts.indicator || s.last === 0) return keep || undefined
  const left = s.last + ttl - now
  const hit = s.total > 0 ? ` · hit ${Math.round((s.read / s.total) * 100)}%` : ''
  const tail = keep ? ` · ${keep}` : ''
  if (left > 0) return `cache ● ${ttlLabel()} ${bar(left / ttl)} ${fmtLeft(left)} left${hit}${tail}`
  const k = Math.round(s.ctx / 1000)
  const recache = s.ctx > 0 ? ` · next message re-caches ~${k > 0 ? `${k}k` : '<1k'} tokens` : ''
  return `cache ○ cold${recache}${tail}`
}

function describe(now: number): string {
  const lines = [indicatorText(now) ?? 'cache: no response yet in this session']
  const src = { config: 'from your settings', learned: 'learned from this account', guess: 'guessed; it is learned after an idle gap' }[ttlSource]
  lines.push(`cache TTL ${ttl >= HOUR ? '1h' : '5m'} (${src})`)
  lines.push(`keepalive: ${s.until > now ? `on, ${fmt(s.until - now)} left, ${s.pings} ping(s)` : 'idle'}` +
    ` · auto ${isAuto() ? 'on' : 'off'}${s.optOut ? ' · off for this session' : ''}`)
  if (ttl < HOUR) lines.push('note: a 5m cache needs a ping about every 4 minutes; auto never runs on 5m, /warm does.')
  return lines.join('\n')
}

// ---- helpers that use $ --------------------------------------------------------

async function save($: EngineInterface) {
  s = { ...s, seen: await $.clock.now() }
  await $.store.set(`s:${sid}`, s)
}

async function show($: EngineInterface) {
  $.ui.status(indicatorText(await $.clock.now()))
}

async function resolveTtl($: EngineInterface) {
  const settings = (await $.settings.read().catch(() => undefined)) as Record<string, unknown> | undefined
  const configured = (await $.env.get('FORCE_PROMPT_CACHING_5M')) === '1' ? '5m'
    : (await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')) ?? (settings?.promptCacheTtl as string | undefined)
      ?? ((await $.env.get('ENABLE_PROMPT_CACHING_1H')) === '1' ? '1h' : undefined)
  if (configured === '5m' || configured === '1h') {
    ttl = configured === '1h' ? HOUR : 5 * MIN
    ttlSource = 'config'
    return
  }
  const learned = await $.store.get('ttl')
  if (learned === '5m' || learned === '1h') {
    ttl = learned === '1h' ? HOUR : 5 * MIN
    ttlSource = 'learned'
    return
  }
  // Subscriptions get 1h by default; API keys, gateways and cloud providers get 5m.
  const isNonSub = [
    await $.env.get('ANTHROPIC_API_KEY'), await $.env.get('ANTHROPIC_AUTH_TOKEN'),
    await $.env.get('ANTHROPIC_BASE_URL'), await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    await $.env.get('CLAUDE_CODE_USE_VERTEX'), await $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
  ].some(Boolean)
  ttl = isNonSub ? 5 * MIN : HOUR
  ttlSource = 'guess'
}

// After an idle gap that only a 1h cache survives, the first request's cache WRITES
// tell which TTL this account really gets. Writes (not reads) are used because a
// multi-step turn's reads include its own later steps.
async function learnTtl($: EngineInterface, gap: number, wrote: number) {
  if (ttlSource === 'config' || s.ctx < 10_000 || gap < 6 * MIN || gap > 54 * MIN) return
  if (wrote <= 0.2 * s.ctx) {
    await $.store.set('ttl', '1h')
    await $.store.delete('ttl5m-votes')
    ttl = HOUR
    ttlSource = 'learned'
  } else if (wrote >= 0.8 * s.ctx) {
    const votes = Number((await $.store.get('ttl5m-votes')) ?? 0) + 1 // one miss can have other causes
    await $.store.set('ttl5m-votes', votes)
    if (votes >= 2) {
      await $.store.set('ttl', '5m')
      ttl = 5 * MIN
      ttlSource = 'learned'
    }
  }
}

async function blockedReason($: EngineInterface): Promise<string | undefined> {
  if ((await $.env.get('CACHE_WARMER_DISABLE')) === '1') return 'CACHE_WARMER_DISABLE=1'
  const home = await $.env.get('HOME')
  if (home && (await $.fs.stat(`${home}/.claude/cache-warmer-off`).then(() => true, () => false)))
    return '~/.claude/cache-warmer-off exists'
  return undefined
}

async function autoArm($: EngineInterface, now: number) {
  if (!isAuto() || s.optOut || ttl < HOUR) return
  if (await blockedReason($)) return
  s = { ...s, until: Math.max(s.until, now + opts.autoWindow) }
}

async function stopWindow($: EngineInterface, why: string, optOut: boolean) {
  s = { ...s, until: 0, optOut: s.optOut || optOut }
  await save($)
  await show($)
  $.ui.toast(`cache-warmer stopped${optOut ? ' for this session' : ''}: ${why}`)
}

async function ping($: EngineInterface, now: number, isManual: boolean): Promise<string> {
  const blocked = await blockedReason($)
  if (blocked) return `cache-warmer: skipped, ${blocked}`
  isPinging = true
  try {
    const r = await $.model.fork({ prompt: PING_PROMPT })
    if (!r.isAnswered) {
      // nothing-to-fork (after /clear) and aborted are not failures of the cache.
      if (!isManual && r.reason === 'api-error') await stopWindow($, `ping failed (${r.reason})`, false)
      return `cache-warmer ping: no reply (${r.reason})`
    }
    const { cache_read_input_tokens: read, cache_creation_input_tokens: wrote, output_tokens: out } = r.usage
    const report = `cache read ${read.toLocaleString()} · wrote ${wrote.toLocaleString()} · output ${out}`
    if (read === 0 || wrote > read * 0.1) {
      await stopWindow($, `ping missed the cache (${report})`, true)
      return `cache-warmer ping MISSED the cache: ${report}. Stopped for this session.`
    }
    s = { ...s, last: await $.clock.now(), pings: s.pings + (isManual ? 0 : 1) }
    await save($)
    await show($)
    return `cache-warmer ping ok: ${report}`
  } finally {
    isPinging = false
  }
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  if (s.until > 0 && now >= s.until) {
    s = { ...s, until: 0 }
    await save($)
  }
  await show($)
  if (s.until <= now || running.size > 0 || isPinging || s.last === 0) return
  const expiresAt = s.last + ttl
  if (now >= expiresAt) return // already cold: a ping would only pay a full write
  if (now < expiresAt - lead()) return
  await ping($, now, false)
}

async function prune($: EngineInterface, now: number) {
  for (const key of await $.store.keys()) {
    if (!key.startsWith('s:') || key === `s:${sid}`) continue
    const rec = (await $.store.get(key)) as Partial<Saved> | undefined
    if (!rec || (rec.seen ?? 0) < now - STALE) await $.store.delete(key)
  }
}

// ---- hooks ---------------------------------------------------------------------

export const register: Register = (on, options) => {
  // Fresh state per load, whatever a previous load of this module left behind.
  isInteractive = false
  isPinging = false
  sid = ''
  s = { ...EMPTY }
  ttl = HOUR
  ttlSource = 'guess'
  autoOverride = undefined
  submittedAt = 0
  running.clear()
  readOptions(options)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    isInteractive = e.isInteractive
    if (!isInteractive) return r // headless and SDK sessions: nothing registered, nothing sent

    sid = await $.session.id()
    s = { ...EMPTY, ...((await $.store.get(`s:${sid}`)) as Partial<Saved> | undefined) }
    const stored = await $.store.get('auto')
    autoOverride = typeof stored === 'boolean' ? stored : undefined
    await resolveTtl($)
    await prune($, await $.clock.now())
    await $.command.register({
      name: 'warm',
      description: 'Prompt-cache keepalive: /warm [2h|off|on|auto on|auto off|status|test]',
      argumentHint: '[2h|off|on|auto on|auto off|status|test]',
    })
    $.clock.every(TICK, () => void tick($))
    await show($)
    return r
  })

  // A real turn refreshes the cache itself; never ping over one. The first turn after
  // an idle gap also marks when that gap ended (for TTL learning).
  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    if (isInteractive) {
      if (running.size === 0) submittedAt = await $.clock.now()
      running.add(e.turnId)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    running.delete(e.turnId)
    if (!isInteractive || e.agentId !== undefined) return r
    const now = await $.clock.now()
    const u = e.usage
    if (u) {
      if (submittedAt > 0 && s.last > 0) await learnTtl($, submittedAt - s.last, u.cache_creation_input_tokens)
      s = {
        ...s,
        read: s.read + u.cache_read_input_tokens,
        total: s.total + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens,
      }
    }
    const ctx = (await $.session.usage().catch(() => undefined))?.context.tokens
    s = { ...s, last: now, ctx: ctx ?? s.ctx }
    submittedAt = 0
    await autoArm($, now)
    await save($)
    await show($)
    return r
  })

  on('command.run', { command: 'warm' }, async ($, e, next) => {
    if (!isInteractive) return next(e)
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    const now = await $.clock.now()
    const done = async (text: string) => {
      await save($)
      await show($)
      return { text }
    }

    if (arg === 'auto on' || arg === 'auto off') {
      autoOverride = arg === 'auto on'
      await $.store.set('auto', autoOverride)
      if (!autoOverride) s = { ...s, until: 0 }
      else if (s.last > 0) await autoArm($, now)
      return done(autoOverride
        ? `cache-warmer auto on: sessions stay warm up to ${fmt(opts.autoWindow)} after each reply${ttl < HOUR ? ' (not on this 5m cache)' : ''}.`
        : 'cache-warmer auto off: use /warm 2h to keep a session warm by hand.')
    }
    if (arg === 'off') {
      s = { ...s, until: 0, optOut: true }
      return done('cache-warmer off for this session (/warm on to undo).')
    }
    if (arg === 'on') {
      s = { ...s, optOut: false }
      if (s.last > 0) await autoArm($, now)
      return done(describe(now))
    }
    if (arg === 'status' || arg === 'help') return { text: describe(now) }
    if (arg === 'test') return { text: await ping($, now, true) }

    const span = arg === '' ? opts.autoWindow : parseWindow(arg)
    if (span === undefined) return { text: 'usage: /warm [2h|90m|off|on|auto on|auto off|status|test]' }
    const blocked = await blockedReason($)
    if (blocked) return { text: `cache-warmer not armed: ${blocked}` }
    const capped = Math.min(span, MAX_WINDOW)
    s = { ...s, until: now + capped, optOut: false }
    const perHour = Math.round(HOUR / (ttl - lead()))
    return done(`cache-warmer on for ${fmt(capped)}${capped < span ? ' (capped at 8h)' : ''}` +
      ` · cache TTL ${ttlLabel()} · about ${perHour} ping${perHour === 1 ? '' : 's'}/hour while idle.`)
  })

  on('session.end', async ($, e, next) => {
    if (isInteractive && sid) await $.store.delete(`s:${sid}`)
    return next(e)
  })
}
