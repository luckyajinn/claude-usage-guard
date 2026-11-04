import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const at = (ms: number): string => new Date(ms).toISOString()

type Limit = { kind: string; percentUsed: number; resetsAt?: string }
const five = (percentUsed: number, resetInMs = HOUR + 12 * MIN): Limit => ({ kind: 'five_hour', percentUsed, resetsAt: at(NOW + resetInMs) })
const seven = (percentUsed: number, resetInMs = 3 * DAY): Limit => ({ kind: 'seven_day', percentUsed, resetsAt: at(NOW + resetInMs) })

const SPAWN = {
  tool_use_id: 't1',
  prompt: 'look around',
  description: 'Scout the repo',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-sonnet-5-5',
  background: false,
  fork: false,
} as const

/**
 * The engine beneath the mod. `usage` is what the engine reports as the latest rate limits
 * (change it between calls); `store` is what is on disk from an earlier session.
 */
function engine(on: On, init: { usage?: Limit[]; store?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: NOW })
  // The mod's own store, in memory: JSON in, JSON out, as the engine keeps it. Tests read it back from `disk`.
  const disk = new Map<string, unknown>(Object.entries(init.store ?? {}))
  const seen = {
    usage: init.usage ?? [],
    disk,
    toasts: [] as string[],
    rows: [] as string[],
    debug: [] as string[],
    status: [] as (string | undefined)[],
  }

  on('store.get', (_, e) => ({ value: disk.get(e.key) }))
  on('store.set', (_, e) => {
    disk.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    disk.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...disk.keys()] }))
  on('command.register', () => ({ value: { command: 'usage-guard' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: seen.usage } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    if (e.to === 'transcript') seen.rows.push(e.text)
    else seen.debug.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  return { clock, seen }
}

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const

/** `/usage-guard <args>` typed by the person at the prompt. */
const slash = (args = '') => ({ command: 'usage-guard', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as const

/** One measurement, as the engine pushes it after a response. */
const measure = ($: { session: { measure: (i: never) => Promise<unknown> } }, rateLimits: Limit[]) =>
  $.session.measure({ context: {}, rateLimits, changed: ['rateLimits'] } as never)

test('a new subagent is refused at the cap, saying why and when the window resets', async ($, on) => {
  engine(on, { usage: [five(96), seven(41)] })
  await $.session.start(START)

  const r = await $.agent.spawn(SPAWN)

  expect(r.deny).toContain('usage-guard blocked this subagent')
  expect(r.deny).toContain('5-hour usage is at 96%')
  expect(r.deny).toContain('95% cap')
  expect(r.deny).toContain('resets in 1h 12m')
  expect(r.agentId).toBeUndefined()
})

test('below the cap a subagent starts as usual', async ($, on) => {
  engine(on, { usage: [five(60), seven(40)] })
  await $.session.start(START)
  const r = await $.agent.spawn(SPAWN)
  expect(r.deny).toBeUndefined()
  expect(r.agentId).toBe('a1')
})

test('either window alone is enough to block', async ($, on) => {
  engine(on, { usage: [five(10), seven(99.9, DAY)] })
  await $.session.start(START)
  const r = await $.agent.spawn(SPAWN)
  expect(r.deny).toContain('7-day usage is at 99.9%')
  expect(r.deny).toContain('resets in 1d')
})

test('the cap is exact: 94.9% starts a subagent, 95% does not', async ($, on) => {
  const w = engine(on, { usage: [five(94.9)] })
  await $.session.start(START)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('a1')
  w.seen.usage = [five(95)]
  expect((await $.agent.spawn(SPAWN)).deny).toContain('usage-guard blocked')
})

test('both windows over the cap are listed with their own reset times', async ($, on) => {
  engine(on, { usage: [five(96), seven(99, 3 * DAY + 4 * HOUR)] })
  await $.session.start(START)
  const r = await $.agent.spawn(SPAWN)
  expect(r.deny).toContain('- 5-hour: 96% used, resets in 1h 12m')
  expect(r.deny).toContain('- 7-day: 99% used, resets in 3d 4h')
})

test('a lower cap from the options blocks earlier', { options: { blockAt: 60, warnAt: 50 } }, async ($, on) => {
  engine(on, { usage: [five(60)] })
  await $.session.start(START)
  const r = await $.agent.spawn(SPAWN)
  expect(r.deny).toContain('60% cap')
})

test('blocking can be switched off: warnings only', { options: { blockSubagents: false } }, async ($, on) => {
  engine(on, { usage: [five(99)] })
  await $.session.start(START)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('a1')
})

test('resuming a subagent that already exists is not blocked', async ($, on) => {
  engine(on, { usage: [five(99)] })
  await $.session.start(START)
  const r = await $.agent.spawn({ ...SPAWN, resume: { agentId: 'a0' } })
  expect(r.agentId).toBe('a1')
})

test('a stored reading from another session blocks when this one has none yet', async ($, on) => {
  engine(on, { usage: [], store: { reading: { observedAt: NOW - MIN, five_hour: { percentUsed: 97, resetsAt: at(NOW + 30 * MIN) } } } })
  await $.session.start(START)
  expect((await $.agent.spawn(SPAWN)).deny).toContain('resets in 30m')
})

test('the higher of this session\'s figure and the stored one is trusted', async ($, on) => {
  engine(on, { usage: [five(90, HOUR)], store: { reading: { observedAt: NOW - MIN, five_hour: { percentUsed: 97, resetsAt: at(NOW + HOUR) } } } })
  await $.session.start(START)
  expect((await $.agent.spawn(SPAWN)).deny).toContain('5-hour usage is at 97%')
})

test('a stored reading from before the last reset never blocks', async ($, on) => {
  engine(on, { usage: [], store: { reading: { observedAt: NOW - 6 * HOUR, five_hour: { percentUsed: 99, resetsAt: at(NOW - HOUR) } } } })
  await $.session.start(START)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('a1')
})

test('no readings at all (an API-key session) blocks nothing', async ($, on) => {
  engine(on, { usage: [] })
  await $.session.start(START)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('a1')
})

test('the guard fails open: if it cannot read its own state, the subagent starts', async ($, on) => {
  // No store is mocked, so every $.store call throws inside the mod.
  mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'usage-guard' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [five(99)] } }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start(START)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('a1')
})

test('crossing the warn level warns once, with the time to reset; falling back re-arms it', async ($, on) => {
  const w = engine(on)
  await $.session.start(START)

  await measure($, [five(79)])
  expect(w.seen.toasts).toEqual([])

  await measure($, [five(82)])
  expect(w.seen.toasts.length).toBe(1)
  expect(w.seen.toasts[0]).toContain('5-hour usage is at 82%')
  expect(w.seen.toasts[0]).toContain('warning at 80%')
  expect(w.seen.toasts[0]).toContain('resets in 1h 12m')
  // The same words are kept in the transcript.
  expect(w.seen.rows).toEqual(w.seen.toasts)

  await measure($, [five(85)])
  await measure($, [five(90)])
  expect(w.seen.toasts.length).toBe(1)

  // A new window (a later reset time), a new climb.
  await measure($, [five(3, 5 * HOUR)])
  expect(w.seen.toasts.length).toBe(1)
  await measure($, [five(81, 5 * HOUR)])
  expect(w.seen.toasts.length).toBe(2)
  expect(w.seen.toasts[1]).toContain('81%')
})

test('the cap announces itself once, pins a status line, and the line clears at the reset', async ($, on) => {
  const w = engine(on)
  await $.session.start(START)

  await measure($, [five(90, 10 * MIN)])
  await measure($, [five(96, 10 * MIN)])
  expect(w.seen.toasts.length).toBe(2)
  expect(w.seen.toasts[1]).toContain('95% cap')
  expect(w.seen.toasts[1]).toContain('New subagents are blocked')
  const pinned = w.seen.status.filter(s => s !== undefined)
  expect(pinned[pinned.length - 1]).toContain('new subagents blocked')

  await measure($, [five(97, 10 * MIN)])
  expect(w.seen.toasts.length).toBe(2)

  // Time passes with no new reading: the window resets and the line is taken down.
  await w.clock.advance(11 * MIN)
  expect(w.seen.status[w.seen.status.length - 1]).toBeUndefined()
})

test('each window warns on its own', async ($, on) => {
  const w = engine(on)
  await $.session.start(START)
  await measure($, [five(85), seven(10)])
  await measure($, [five(86), seven(88)])
  expect(w.seen.toasts.length).toBe(2)
  expect(w.seen.toasts[0]).toContain('5-hour')
  expect(w.seen.toasts[1]).toContain('7-day')
})

test('only the last reading is kept, and only the windows it holds', async ($, on) => {
  const w = engine(on)
  await $.session.start(START)

  await measure($, [{ ...five(50), extra: 'dropped' } as Limit, { kind: 'spend_limit', percentUsed: 12 }])
  await measure($, [five(52)])

  expect([...w.seen.disk.keys()]).toEqual(['reading'])
  const kept = w.seen.disk.get('reading') as Record<string, unknown>
  expect(Object.keys(kept).sort()).toEqual(['five_hour', 'observedAt'])
  expect(kept.five_hour).toEqual({ percentUsed: 52, resetsAt: at(NOW + HOUR + 12 * MIN) })
  expect(kept.observedAt).toBe(NOW)
})

test('an empty measurement keeps the earlier reading and says nothing', async ($, on) => {
  const w = engine(on)
  await $.session.start(START)
  await measure($, [five(50)])
  await measure($, [])
  expect((w.seen.disk.get('reading') as { five_hour: { percentUsed: number } }).five_hour.percentUsed).toBe(50)
  expect(w.seen.toasts).toEqual([])
})

test('a reading folds into a higher one another session stored for the same window', async ($, on) => {
  const w = engine(on, { store: { reading: { observedAt: NOW - MIN, five_hour: { percentUsed: 88, resetsAt: at(NOW + HOUR + 12 * MIN) } } } })
  await $.session.start(START)
  await measure($, [five(86)])
  expect((w.seen.disk.get('reading') as { five_hour: { percentUsed: number } }).five_hour.percentUsed).toBe(88)
  // Warned once, off the higher figure, in this session.
  expect(w.seen.toasts.length).toBe(1)
  expect(w.seen.toasts[0]).toContain('88%')
})

test('/usage-guard prints readings, thresholds and whether blocking is active', async ($, on) => {
  engine(on, { usage: [five(96), seven(41)] })
  await $.session.start(START)

  const { text } = await $.command.run(slash())

  expect(text).toContain('96% used, resets in 1h 12m')
  expect(text).toContain('41% used, resets in 3d')
  expect(text).toContain('Warn at 80% used. Cap 95% used. Blocking new subagents: on.')
  expect(text).toContain('Blocking is ACTIVE')
})

test('/usage-guard adjusts thresholds and the change sticks', async ($, on) => {
  const w = engine(on, { usage: [five(72)] })
  await $.session.start(START)

  const warn = await $.command.run(slash('warn 70'))
  expect(warn.text).toContain('Warn level set to 70% used.')
  expect(warn.text).toContain('Warn at 70% used.')
  expect(w.seen.disk.get('overrides')).toEqual({ warnAt: 70 })

  // The new level applies to the next reading.
  await measure($, [five(72)])
  expect(w.seen.toasts.length).toBe(1)
  expect(w.seen.toasts[0]).toContain('warning at 70%')

  const cap = await $.command.run(slash('cap 72'))
  expect(cap.text).toContain('Cap set to 72% used.')
  expect((await $.agent.spawn(SPAWN)).deny).toContain('72% cap')

  const off = await $.command.run(slash('block off'))
  expect(off.text).toContain('Blocking turned off')
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('a1')

  const reset = await $.command.run(slash('reset'))
  expect(reset.text).toContain('Warn at 80% used. Cap 95% used. Blocking new subagents: on.')
  expect(w.seen.disk.has('overrides')).toBe(false)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('a1')
})

test('/usage-guard refuses a threshold that would cross the other and says nothing was changed', async ($, on) => {
  const w = engine(on, { usage: [five(50)] })
  await $.session.start(START)

  const bad = await $.command.run(slash('cap 50'))
  expect(bad.text).toContain('cannot be below the warn level (80%)')
  expect(bad.text).toContain('Nothing was changed')
  const junk = await $.command.run(slash('warn lots'))
  expect(junk.text).toContain('needs a percent from 1 to 100')
  expect(w.seen.disk.has('overrides')).toBe(false)
})

test('/usage-guard help lists the options', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const { text } = await $.command.run(slash('help'))
  expect(text).toContain('/usage-guard warn <1-100>')
  expect(text).toContain('/usage-guard block on|off')
})

test('with no readings the command says so instead of showing zeros', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const { text } = await $.command.run(slash())
  expect(text).toContain('No usage readings yet')
  expect(text).toContain('Blocking is not active.')
})

// ---- the panel (/usage-guard ui) ----

const PANEL = {
  plugin: 'usage-guard',
  component: 'Pane',
  requestId: 'usage-guard',
  props: { title: 'Usage guard', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('/usage-guard ui opens the panel, asking for the keyboard', async ($, on) => {
  engine(on)
  const opened: unknown[] = []
  on('ui.open', (_, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  await $.session.start(START)
  const { text } = await $.command.run(slash('ui'))
  expect(text).toContain('panel opened')
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'usage-guard', focus: true, closeOnEscape: true })
})

test('where the panel cannot open, /usage-guard ui gives the readout instead', async ($, on) => {
  engine(on, { usage: [five(83)] })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  await $.session.start(START)
  const { text } = await $.command.run(slash('ui'))
  expect(text).toContain('could not open here')
  expect(text).toContain('5-hour')
  expect(text).toContain('83% used')
})

test('the panel shows both windows with a meter, the percent in words and the reset time', async ($, on) => {
  engine(on, { usage: [five(96), seven(41)] })
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANEL, surface })
    expect((await ui.find({ type: 'Text', text: /5-hour.*96%.*at cap.*resets in 1h 12m/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /7-day.*41%.*ok.*resets in 3d/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /BLOCKED now/ }))?.text).toBeDefined()
    await ui.unmount()
  }
})

test('the panel with no reading says so and nothing is blocked', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANEL, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Text', text: /no reading yet/ })).toHaveLength(2)
  expect((await ui.find({ type: 'Text', text: /allowed/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('panel buttons change the cap, the warn level and blocking, and save them', async ($, on) => {
  const w = engine(on, { usage: [five(83)] })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANEL, surface: 'terminal' })

  await ui.press({ key: 'cap-down' })
  expect(w.seen.disk.get('overrides')).toEqual({ blockAt: 90 })
  expect((await ui.find({ type: 'Text', text: /cap 90%/ }))?.text).toBeDefined()

  await ui.press({ key: 'warn-down' })
  expect(w.seen.disk.get('overrides')).toEqual({ blockAt: 90, warnAt: 75 })

  await ui.press({ key: 'block' })
  expect((w.seen.disk.get('overrides') as { blockSubagents: boolean }).blockSubagents).toBe(false)
  expect((await ui.find({ type: 'Text', text: /never blocked/ }))?.text).toBeDefined()

  await ui.press({ key: 'reset' })
  expect(w.seen.disk.has('overrides')).toBe(false)
  expect((await ui.find({ type: 'Text', text: /cap 95%/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('a panel change that is refused leaves the settings alone and says why', { options: { warnAt: 90, blockAt: 90 } }, async ($, on) => {
  const w = engine(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANEL, surface: 'terminal' })
  await ui.press({ key: 'cap-down' })
  expect(w.seen.disk.has('overrides')).toBe(false)
  expect((await ui.find({ type: 'Text', text: /cannot be below the warn level/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('a panel change takes effect on the next subagent', async ($, on) => {
  engine(on, { usage: [five(85)] })
  await $.session.start(START)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('a1')
  const ui = await $.ui.mount({ ...PANEL, surface: 'terminal' })
  await ui.press({ key: 'warn-down' })
  await ui.press({ key: 'cap-down' })
  await ui.press({ key: 'cap-down' })
  expect((await $.agent.spawn(SPAWN)).deny).toContain('85% cap')
  await ui.unmount()
})
