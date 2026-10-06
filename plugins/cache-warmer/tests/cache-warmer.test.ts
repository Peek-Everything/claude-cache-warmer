import { describe, expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const HOUR = 60 * MIN
const CTX = 150_000
const HIT = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: CTX, cache_creation_input_tokens: 40 }
const MISS = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: CTX }
type Usage = typeof HIT

type WorldOpts = {
  env?: Record<string, string>
  usage?: Usage
  settings?: Record<string, unknown>
  store?: Record<string, unknown>
  deleted?: string[] // when given, a hand-rolled store that records deletions
}

// The world beneath the plugin: clock, store, env, settings, a counted fork, and
// what the plugin drew (status lines, toasts, commands).
function world(on: any, o: WorldOpts = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  if (o.deleted) {
    const m = new Map<string, unknown>(Object.entries(o.store ?? {}))
    const del = o.deleted
    on('store.get', ($: any, e: any) => ({ value: m.get(e.key) }))
    on('store.set', ($: any, e: any) => { m.set(e.key, e.value); return { value: undefined } })
    on('store.delete', ($: any, e: any) => { m.delete(e.key); del.push(e.key); return { value: undefined } })
    on('store.keys', () => ({ value: [...m.keys()] }))
  } else mock.store(on, o.store ?? {})
  mock.env(on, { HOME: '/home/t', ...(o.env ?? {}) })
  const forks: number[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const registered: string[] = []
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('command.run', () => ({ text: 'engine' }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: CTX, window: 200_000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: o.settings ?? {} }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('command.register', ($: any, e: any) => { registered.push(e.name); return { value: {} } })
  on('ui.status', ($: any, e: any) => { statuses.push(e.text); return { value: undefined } })
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('model.fork', () => {
    forks.push(clock.now())
    return { value: { isAnswered: true, text: 'ok', usage: o.usage ?? HIT } }
  })
  return { clock, forks, toasts, statuses, registered, last: () => statuses.at(-1) }
}

let turnN = 0
const start = ($: any, isInteractive = true) =>
  $.session.start({ cwd: '/tmp', surface: isInteractive ? 'terminal' : null, isInteractive })
// One full main-thread turn: start, then complete with the given usage.
const turn = async ($: any, usage: Usage = HIT) => {
  const turnId = `t${++turnN}`
  await $.turn.start({ text: 'hi', turnId })
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId, reason: 'answer', usage: { ...usage, model: 'm' } })
}
const warm = ($: any, args: string) => $.command.run({ command: 'warm', args })
const AUTO = { options: { auto: true } }

describe('scope', () => {
  test('non-interactive (claude -p / SDK hosts): nothing registered, drawn, stored or sent', async ($, on) => {
    const w = world(on)
    await start($, false)
    expect(w.registered).toHaveLength(0)
    await turn($)
    expect((await warm($, '2h')).text).toBe('engine')
    await w.clock.advance(10 * HOUR)
    expect(w.forks).toHaveLength(0)
    expect(w.statuses).toHaveLength(0)
  })

  test('auto is OFF by default: no pings without /warm', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($)
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(0)
  })
})

describe('indicator', () => {
  test('nothing before the first response', async ($, on) => {
    const w = world(on, { settings: { promptCacheTtl: '1h' } })
    await start($)
    expect(w.last()).toBeUndefined()
  })

  test('warm: TTL, bar, time left, hit ratio; then cold with the re-cache estimate', async ($, on) => {
    const w = world(on, { settings: { promptCacheTtl: '1h' } })
    await start($)
    await turn($, { input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 10 })
    expect(w.last()).toBe('cache ● 1h ██████ 60m left · hit 90%')
    await w.clock.advance(23 * MIN)
    expect(w.last()).toContain('████░░ 37m left')
    await w.clock.advance(40 * MIN)
    expect(w.last()).toBe('cache ○ cold · next message re-caches ~150k tokens')
  })

  test('a guessed TTL is marked with ~', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($)
    expect(w.last()).toContain('cache ● ~1h')
  })

  test('indicator off: only the keepalive part is shown', { options: { indicator: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    await turn($)
    expect(w.last()).toBeUndefined()
    await warm($, '2h')
    expect(w.last()).toMatch(/^keepalive 2h00m ↻0$/)
  })
})

describe('keepalive', () => {
  test('/warm 2h: one ping ~5m before the 1h expiry, then every ~55m, then stops', async ($, on) => {
    const w = world(on, { settings: { promptCacheTtl: '1h' } })
    await start($)
    await turn($)
    const t0 = w.clock.now()
    expect((await warm($, '2h')).text).toContain('cache-warmer on for 2h00m')
    await w.clock.advance(54 * MIN)
    expect(w.forks).toHaveLength(0)
    await w.clock.advance(2 * MIN)
    expect(w.forks).toHaveLength(1)
    expect(w.forks[0]! - t0).toBeGreaterThanOrEqual(55 * MIN)
    await w.clock.advance(5 * HOUR)
    expect(w.forks).toHaveLength(2)
    expect(w.last()).toContain('cache ○ cold')
  })

  test('auto (option on): each reply restarts the window; stops 2h after the last reply', AUTO, async ($, on) => {
    const w = world(on, { settings: { promptCacheTtl: '1h' } })
    await start($)
    await turn($)
    await w.clock.advance(100 * MIN)
    await turn($)
    const t1 = w.clock.now()
    await w.clock.advance(5 * HOUR)
    expect(w.forks.filter(t => t > t1)).toHaveLength(2)
  })

  test('/warm auto on persists and overrides the option', async ($, on) => {
    const w = world(on, { settings: { promptCacheTtl: '1h' } })
    await start($)
    await turn($)
    await warm($, 'auto on')
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(2)
  })

  test('auto never runs on a 5m cache; /warm still can, and says how often it pings', AUTO, async ($, on) => {
    const w = world(on, { settings: { promptCacheTtl: '5m' } })
    await start($)
    await turn($)
    await w.clock.advance(HOUR)
    expect(w.forks).toHaveLength(0)
    await turn($)
    expect((await warm($, '30m')).text).toContain('about 15 pings/hour')
    await w.clock.advance(4 * MIN + 31_000)
    expect(w.forks).toHaveLength(1)
  })

  test('/warm off opts the session out; auto does not re-arm it', AUTO, async ($, on) => {
    const w = world(on, { settings: { promptCacheTtl: '1h' } })
    await start($)
    await turn($)
    await warm($, 'off')
    await turn($)
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(0)
  })

  test('never pings over a running turn', async ($, on) => {
    const w = world(on, { settings: { promptCacheTtl: '1h' } })
    await start($)
    await turn($)
    await warm($, '2h')
    await $.turn.start({ text: 'long', turnId: 'long-1' })
    await w.clock.advance(59 * MIN)
    expect(w.forks).toHaveLength(0)
  })

  test('a ping that misses the cache stops it and opts the session out', AUTO, async ($, on) => {
    const w = world(on, { usage: MISS, settings: { promptCacheTtl: '1h' } })
    await start($)
    await turn($)
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(1)
    expect(w.toasts.join(' ')).toContain('missed the cache')
    await turn($)
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(1)
  })

  test('CACHE_WARMER_DISABLE=1: auto does not arm, /warm refuses', AUTO, async ($, on) => {
    const w = world(on, { env: { CACHE_WARMER_DISABLE: '1' }, settings: { promptCacheTtl: '1h' } })
    await start($)
    await turn($)
    expect(w.last()).not.toContain('keepalive') // auto did not arm
    expect((await warm($, '2h')).text).toContain('CACHE_WARMER_DISABLE')
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(0)
    expect(w.last()).not.toContain('keepalive')
  })

  test('never pings a cache that is already cold', async ($, on) => {
    const w = world(on, { settings: { promptCacheTtl: '1h' } })
    await start($)
    await turn($)
    await w.clock.advance(61 * MIN)
    await warm($, '2h')
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(0)
  })

  test('8h cap', async ($, on) => {
    world(on)
    await start($)
    expect((await warm($, '24h')).text).toContain('capped at 8h')
  })
})

describe('TTL', () => {
  test('API key without config: guessed 5m', async ($, on) => {
    const w = world(on, { env: { ANTHROPIC_API_KEY: 'x' } })
    await start($)
    await turn($)
    expect(w.last()).toContain('cache ● ~5m')
  })

  test('learns 1h when a request after a 6m+ gap wrote almost nothing', async ($, on) => {
    const w = world(on, { env: { ANTHROPIC_API_KEY: 'x' } })
    await start($)
    await turn($)
    await w.clock.advance(20 * MIN)
    await turn($, HIT)
    expect(w.last()).toContain('cache ● 1h') // no ~: learned
  })

  test('learns 5m only after two full re-writes after a 6m+ gap', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($)
    await w.clock.advance(20 * MIN)
    await turn($, MISS)
    expect(w.last()).toContain('~1h')
    await w.clock.advance(20 * MIN)
    await turn($, MISS)
    expect(w.last()).toContain('cache ● 5m') // learned (no ~)
    await w.clock.advance(6 * MIN)
    expect(w.last()).toContain('cache ○ cold')
  })

  test('configured TTL is never overridden by learning', async ($, on) => {
    const w = world(on, { settings: { promptCacheTtl: '1h' } })
    await start($)
    await turn($)
    for (let i = 0; i < 3; i++) {
      await w.clock.advance(20 * MIN)
      await turn($, MISS)
    }
    expect(w.last()).toContain('cache ● 1h')
  })
})

describe('housekeeping', () => {
  test('prunes other sessions\' records older than a day', async ($, on) => {
    const deleted: string[] = []
    const w = world(on, { deleted, store: { 's:old': { seen: 0 }, 's:fresh': { seen: 999_999_999_999 } } })
    await w.clock.advance(48 * HOUR)
    await start($)
    expect(deleted).toEqual(['s:old'])
  })
})
