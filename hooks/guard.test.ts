import { expect, test } from 'claude-code/testing'

import {
  DEFAULTS,
  applyCommand,
  blockReason,
  blockers,
  commandText,
  evaluate,
  formatDuration,
  freshFlags,
  mergeReadings,
  meter,
  noticeText,
  nextClear,
  parseCommand,
  parseFlags,
  parseOverrides,
  parseReading,
  pickReading,
  pct,
  resolveSettings,
  statesOf,
  statusLine,
  stepped,
  windowState,
} from './guard'
import type { Settings, WindowState } from './guard'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const at = (ms: number): string => new Date(ms).toISOString()

const S: Settings = { warnAt: 80, blockAt: 95, blockSubagents: true }

/** A window state without going through a reading. */
const win = (kind: WindowState['kind'], percentUsed: number, resetInMs: number | null = HOUR, expired = false): WindowState => ({
  kind,
  percentUsed,
  resetsAtMs: resetInMs === null ? null : NOW + resetInMs,
  expired,
})

test('pickReading keeps the two windows and drops everything else', () => {
  const r = pickReading(
    [
      { kind: 'five_hour', percentUsed: 41.5, resetsAt: at(NOW + 2 * HOUR), extra: 'ignored' },
      { kind: 'seven_day', percentUsed: 12 },
      { kind: 'spend_limit', percentUsed: 99 },
    ],
    NOW,
  )
  expect(r).toEqual({ observedAt: NOW, five_hour: { percentUsed: 41.5, resetsAt: at(NOW + 2 * HOUR) }, seven_day: { percentUsed: 12 } })

  // Nothing usable in, nothing out.
  expect(pickReading([], NOW)).toBeNull()
  expect(pickReading(undefined, NOW)).toBeNull()
  expect(pickReading([{ kind: 'spend_limit', percentUsed: 50 }], NOW)).toBeNull()
  expect(pickReading([{ kind: 'five_hour', percentUsed: Number.NaN }], NOW)).toBeNull()
  expect(pickReading([{ kind: 'five_hour', percentUsed: '90' }], NOW)).toBeNull()

  // Out-of-range percents are clamped; a bad reset time is dropped, the percent kept.
  const odd = pickReading([{ kind: 'five_hour', percentUsed: 140, resetsAt: 'tomorrow-ish' }, { kind: 'seven_day', percentUsed: -3 }], NOW)
  expect(odd).toEqual({ observedAt: NOW, five_hour: { percentUsed: 100 }, seven_day: { percentUsed: 0 } })
})

test('parseReading accepts what pickReading wrote and rejects the rest', () => {
  const r = { observedAt: NOW, five_hour: { percentUsed: 50, resetsAt: at(NOW + HOUR) } }
  expect(parseReading(r)).toEqual(r)
  expect(parseReading(JSON.parse(JSON.stringify(r)))).toEqual(r)
  expect(parseReading(null)).toBeNull()
  expect(parseReading('x')).toBeNull()
  expect(parseReading({ five_hour: { percentUsed: 50 } })).toBeNull()
  expect(parseReading({ observedAt: NOW })).toBeNull()
  expect(parseReading({ observedAt: 'now', five_hour: { percentUsed: 50 } })).toBeNull()
  // Only the three kept fields survive a round trip through a stored value that grew extras.
  expect(parseReading({ observedAt: NOW, five_hour: { percentUsed: 50, junk: 1 }, token: 'x' })).toEqual({
    observedAt: NOW,
    five_hour: { percentUsed: 50 },
  })
})

test('a reading expires at its reset, or when it is older than its window', () => {
  const withReset = { observedAt: NOW - HOUR, five_hour: { percentUsed: 97, resetsAt: at(NOW + 10 * MIN) } }
  expect(windowState(withReset, 'five_hour', NOW)?.expired).toBe(false)
  // At the reset instant it counts as reset.
  expect(windowState(withReset, 'five_hour', NOW + 10 * MIN)?.expired).toBe(true)
  expect(windowState(withReset, 'seven_day', NOW)).toBeNull()

  // No reset time: judged by age against the window length.
  const noReset = { observedAt: NOW - 4 * HOUR, five_hour: { percentUsed: 97 }, seven_day: { percentUsed: 97 } }
  expect(windowState(noReset, 'five_hour', NOW)?.expired).toBe(false)
  expect(windowState(noReset, 'five_hour', NOW + 2 * HOUR)?.expired).toBe(true)
  expect(windowState(noReset, 'seven_day', NOW + 2 * HOUR)?.expired).toBe(false)

  expect(statesOf(null, NOW)).toEqual([])
  expect(statesOf(noReset, NOW).map(s => s.kind)).toEqual(['five_hour', 'seven_day'])
})

test('mergeReadings keeps the higher live figure and drops a window that reset', () => {
  const mine = { observedAt: NOW, five_hour: { percentUsed: 60, resetsAt: at(NOW + HOUR) }, seven_day: { percentUsed: 30, resetsAt: at(NOW + 2 * DAY) } }
  const theirs = { observedAt: NOW - MIN, five_hour: { percentUsed: 72, resetsAt: at(NOW + HOUR) }, seven_day: { percentUsed: 20, resetsAt: at(NOW + 2 * DAY) } }
  const merged = mergeReadings(mine, theirs, NOW)
  expect(merged?.five_hour?.percentUsed).toBe(72)
  expect(merged?.seven_day?.percentUsed).toBe(30)
  expect(merged?.observedAt).toBe(NOW)

  // The stored five-hour window has reset since: the live one stands even though it is lower.
  const stale = { observedAt: NOW - 6 * HOUR, five_hour: { percentUsed: 99, resetsAt: at(NOW - HOUR) } }
  expect(mergeReadings(mine, stale, NOW)?.five_hour).toEqual(mine.five_hour)
  // Different windows (reset times far apart): the later window is the newer one, even if its figure is lower.
  const older = { observedAt: NOW - MIN, five_hour: { percentUsed: 90, resetsAt: at(NOW + HOUR) } }
  const newer = { observedAt: NOW, five_hour: { percentUsed: 3, resetsAt: at(NOW + 5 * HOUR) } }
  expect(mergeReadings(newer, older, NOW)?.five_hour?.percentUsed).toBe(3)
  expect(mergeReadings(older, newer, NOW)?.five_hour?.percentUsed).toBe(3)
  // Reset times a few seconds apart are one window: the higher figure stands.
  const jitter = { observedAt: NOW, five_hour: { percentUsed: 70, resetsAt: at(NOW + HOUR + 5_000) } }
  expect(mergeReadings(jitter, older, NOW)?.five_hour?.percentUsed).toBe(90)
  // One side missing.
  expect(mergeReadings(null, mine, NOW)).toEqual(mine)
  expect(mergeReadings(mine, null, NOW)).toEqual(mine)
  expect(mergeReadings(null, null, NOW)).toBeNull()
})

test('settings: command change beats the option, the option beats the default, junk is ignored', () => {
  expect(resolveSettings({}, {}).settings).toEqual(DEFAULTS)
  expect(resolveSettings({ warnAt: 70, blockAt: 90, blockSubagents: false }, {}).settings).toEqual({ warnAt: 70, blockAt: 90, blockSubagents: false })

  const r = resolveSettings({ warnAt: 70, blockAt: 90 }, { warnAt: 60, blockSubagents: false })
  expect(r.settings).toEqual({ warnAt: 60, blockAt: 90, blockSubagents: false })
  expect(r.overridden).toEqual(['warnAt', 'blockSubagents'])

  // Values outside 1-100 or of the wrong type fall back.
  expect(resolveSettings({ warnAt: 0, blockAt: 'high', blockSubagents: 'yes' }, {}).settings).toEqual(DEFAULTS)
  expect(resolveSettings({ warnAt: 101 }, {}).settings.warnAt).toBe(80)

  // A warn level above the cap is held at the cap, with a note saying so.
  const held = resolveSettings({ warnAt: 99, blockAt: 90 }, {})
  expect(held.settings.warnAt).toBe(90)
  expect(held.notes.length).toBe(1)
  expect(held.notes[0]).toContain('held at the cap')

  expect(parseOverrides({ warnAt: 70, blockAt: 500, blockSubagents: 'no', other: 1 })).toEqual({ warnAt: 70 })
  expect(parseOverrides(null)).toEqual({})
  expect(parseOverrides([1, 2])).toEqual({})
})

test('the command parses its words', () => {
  expect(parseCommand('')).toEqual({ kind: 'status' })
  expect(parseCommand('  status ')).toEqual({ kind: 'status' })
  expect(parseCommand('HELP')).toEqual({ kind: 'help' })
  expect(parseCommand('reset')).toEqual({ kind: 'reset' })
  expect(parseCommand('warn 70')).toEqual({ kind: 'warn', value: 70 })
  expect(parseCommand('warn 72.5%')).toEqual({ kind: 'warn', value: 72.5 })
  expect(parseCommand('cap 90')).toEqual({ kind: 'cap', value: 90 })
  expect(parseCommand('block off')).toEqual({ kind: 'block', on: false })
  expect(parseCommand('block ON')).toEqual({ kind: 'block', on: true })

  for (const bad of ['warn', 'warn abc', 'warn 0', 'warn 101', 'cap -5', 'block', 'block maybe', 'frobnicate']) {
    expect(parseCommand(bad).kind).toBe('error')
  }
})

test('applying a command changes only what it names, and refuses a warn above the cap', () => {
  const none = {}
  expect(applyCommand({ kind: 'status' }, none, S)).toEqual({ overrides: none, changed: false, message: null })

  const warn = applyCommand({ kind: 'warn', value: 70 }, none, S)
  expect(warn.overrides).toEqual({ warnAt: 70 })
  expect(warn.changed).toBe(true)
  expect(warn.message).toContain('70%')

  const cap = applyCommand({ kind: 'cap', value: 90 }, { warnAt: 70 }, S)
  expect(cap.overrides).toEqual({ warnAt: 70, blockAt: 90 })

  // Order matters: neither side may cross the other.
  const tooHigh = applyCommand({ kind: 'warn', value: 96 }, none, S)
  expect(tooHigh.changed).toBe(false)
  expect(tooHigh.overrides).toEqual(none)
  expect(tooHigh.message).toContain('Nothing was changed')
  const tooLow = applyCommand({ kind: 'cap', value: 50 }, none, S)
  expect(tooLow.changed).toBe(false)

  expect(applyCommand({ kind: 'block', on: false }, none, S).overrides).toEqual({ blockSubagents: false })
  expect(applyCommand({ kind: 'reset' }, { warnAt: 70, blockAt: 90 }, S)).toMatchObject({ overrides: {}, changed: true })
  // Reset with nothing to reset is not a change.
  expect(applyCommand({ kind: 'reset' }, none, S).changed).toBe(false)
  expect(applyCommand({ kind: 'error', message: 'Unknown option "x".' }, none, S).message).toContain('Unknown option')
})

test('a warning speaks once per climb and is armed again when usage falls back', () => {
  let flags = freshFlags()
  const step = (p: number) => {
    const r = evaluate([win('five_hour', p)], flags, S)
    flags = r.flags
    return r.notices.map(n => n.type)
  }

  expect(step(50)).toEqual([])
  expect(step(79.9)).toEqual([])
  expect(step(80)).toEqual(['warn']) // the crossing
  expect(step(83)).toEqual([]) // still above: quiet
  expect(step(94)).toEqual([])
  expect(step(95)).toEqual(['cap']) // the second threshold speaks too
  expect(step(99)).toEqual([])
  // The window resets, usage starts over, and the next climb warns again.
  expect(step(2)).toEqual([])
  expect(step(81)).toEqual(['warn'])
  // Dropping from the cap to between the levels does not repeat the warning, but re-arms the cap.
  expect(step(96)).toEqual(['cap'])
  expect(step(85)).toEqual([])
  expect(step(96)).toEqual(['cap'])
})

test('a jump straight past both levels gives the cap notice only', () => {
  const r = evaluate([win('five_hour', 97)], freshFlags(), S)
  expect(r.notices.map(n => n.type)).toEqual(['cap'])
  // And no warn notice follows once it falls between the levels in the same window.
  expect(evaluate([win('five_hour', 88)], r.flags, S).notices).toEqual([])
})

test('the two windows are tracked apart, and a window the reading lacks keeps its flags', () => {
  const first = evaluate([win('five_hour', 85), win('seven_day', 10)], freshFlags(), S)
  expect(first.notices.map(n => n.window.kind)).toEqual(['five_hour'])

  // Only the seven-day window is reported this time: five-hour stays armed as it was.
  const second = evaluate([win('seven_day', 90)], first.flags, S)
  expect(second.notices.map(n => n.window.kind)).toEqual(['seven_day'])
  expect(evaluate([win('five_hour', 86)], second.flags, S).notices).toEqual([])
})

test('an expired reading re-arms the window and never warns', () => {
  const warned = evaluate([win('five_hour', 90)], freshFlags(), S)
  expect(warned.flags.warn.five_hour).toBe(true)
  const expired = evaluate([win('five_hour', 90, HOUR, true)], warned.flags, S)
  expect(expired.notices).toEqual([])
  expect(expired.flags).toEqual(freshFlags())
})

test('flags read back from state; junk starts over', () => {
  const f = evaluate([win('five_hour', 99)], freshFlags(), S).flags
  expect(parseFlags(JSON.parse(JSON.stringify(f)))).toEqual(f)
  expect(parseFlags(null)).toEqual(freshFlags())
  expect(parseFlags({ warn: 1, cap: 'x' })).toEqual(freshFlags())
  expect(parseFlags({ warn: { five_hour: 'true' } })).toEqual(freshFlags())
})

test('blocking: at or above the cap, not expired, only while enabled', () => {
  const states = [win('five_hour', 94.9), win('seven_day', 95)]
  expect(blockers(states, S).map(w => w.kind)).toEqual(['seven_day'])
  expect(blockers([win('five_hour', 100)], S).length).toBe(1)
  expect(blockers([win('five_hour', 40), win('seven_day', 40)], S)).toEqual([])
  // A reading from before the last reset never blocks.
  expect(blockers([win('five_hour', 99, HOUR, true)], S)).toEqual([])
  // Turned off: nothing is refused, however high.
  expect(blockers([win('five_hour', 99)], { ...S, blockSubagents: false })).toEqual([])
  // The cap moves with the setting.
  expect(blockers([win('five_hour', 85)], { ...S, blockAt: 85 }).length).toBe(1)
  expect(blockers([win('five_hour', 85)], { ...S, blockAt: 86 }).length).toBe(0)
})

test('durations read as whole minutes, hours or days', () => {
  expect(formatDuration(0)).toBe('under a minute')
  expect(formatDuration(59_000)).toBe('under a minute')
  expect(formatDuration(MIN)).toBe('1m')
  expect(formatDuration(47 * MIN + 30_000)).toBe('47m')
  expect(formatDuration(HOUR)).toBe('1h')
  expect(formatDuration(HOUR + 12 * MIN)).toBe('1h 12m')
  expect(formatDuration(23 * HOUR + 59 * MIN)).toBe('23h 59m')
  expect(formatDuration(DAY)).toBe('1d')
  expect(formatDuration(3 * DAY + 4 * HOUR + 30 * MIN)).toBe('3d 4h')
  expect(pct(83)).toBe('83%')
  expect(pct(83.46)).toBe('83.5%')
})

test('the warning and cap notices carry the percent, the threshold and the time to reset', () => {
  const w = win('five_hour', 83, HOUR + 12 * MIN)
  const warn = noticeText({ type: 'warn', window: w }, S, NOW)
  expect(warn).toContain('5-hour usage is at 83%')
  expect(warn).toContain('warning at 80%')
  expect(warn).toContain('resets in 1h 12m')

  const cap = noticeText({ type: 'cap', window: win('seven_day', 96, 2 * DAY + 3 * HOUR) }, S, NOW)
  expect(cap).toContain('7-day usage is at 96%')
  expect(cap).toContain('95% cap')
  expect(cap).toContain('New subagents are blocked')
  expect(cap).toContain('resets in 2d 3h')

  // With blocking off the notice says nothing is refused.
  const off = noticeText({ type: 'cap', window: win('five_hour', 97) }, { ...S, blockSubagents: false }, NOW)
  expect(off).toContain('blocking is off')
  expect(off).toContain('nothing is refused')

  // No reset time from the engine: say so rather than invent one.
  expect(noticeText({ type: 'warn', window: win('five_hour', 85, null) }, S, NOW)).toContain('reset time unknown')
})

test('the refusal says why, which window, and when it resets', () => {
  const one = blockReason([win('five_hour', 96.4, 47 * MIN)], S, NOW)
  expect(one).toContain('usage-guard blocked this subagent')
  expect(one).toContain('5-hour usage is at 96.4%')
  expect(one).toContain('95% cap')
  expect(one).toContain('resets in 47m')
  expect(one).toContain('/usage-guard')

  const both = blockReason([win('five_hour', 96, HOUR), win('seven_day', 99, 3 * DAY)], S, NOW)
  expect(both).toContain('- 5-hour: 96% used, resets in 1h')
  expect(both).toContain('- 7-day: 99% used, resets in 3d')
  expect(both).toContain('every window above has reset')
})

test('the status line names the blockers; the next clear is the earliest reset', () => {
  const hit = [win('five_hour', 96, HOUR), win('seven_day', 99, DAY)]
  const line = statusLine(hit, S, NOW)
  expect(line).toContain('new subagents blocked')
  expect(line).toContain('5-hour 96%')
  expect(line).toContain('7-day 99%')
  expect(nextClear(hit)).toBe(NOW + HOUR)
  expect(nextClear([win('five_hour', 96, null)])).toBeNull()
  expect(nextClear([])).toBeNull()
})

test('the readout shows readings, thresholds and whether blocking is active', () => {
  const reading = {
    observedAt: NOW - 3 * MIN,
    five_hour: { percentUsed: 96, resetsAt: at(NOW + HOUR + 12 * MIN) },
    seven_day: { percentUsed: 41, resetsAt: at(NOW + 3 * DAY) },
  }
  const base = { reading, settings: S, overridden: [] as const, notes: [] as const, now: NOW }

  const active = commandText(base)
  expect(active).toContain('5-hour')
  expect(active).toContain('96% used')
  expect(active).toContain('resets in 1h 12m')
  expect(active).toContain('7-day')
  expect(active).toContain('41% used')
  expect(active).toContain('Warn at 80% used. Cap 95% used. Blocking new subagents: on.')
  expect(active).toContain('Blocking is ACTIVE')
  expect(active).toContain('Last reading: 3m ago')
  expect(active).toContain('/usage-guard warn <1-100>')

  const calm = commandText({ ...base, reading: { ...reading, five_hour: { percentUsed: 60, resetsAt: reading.five_hour.resetsAt } } })
  expect(calm).toContain('Blocking is not active.')

  const off = commandText({ ...base, settings: { ...S, blockSubagents: false }, overridden: ['blockSubagents'] })
  expect(off).toContain('Blocking new subagents: off')
  expect(off).toContain('nothing is refused')
  expect(off).toContain('Changed with this command: blockSubagents')

  // A window whose reset has passed is not shown as current.
  const reset = commandText({ ...base, now: NOW + 2 * HOUR })
  expect(reset).toContain('that window has reset')
  expect(reset).toContain('Blocking is not active.')

  const none = commandText({ ...base, reading: null })
  expect(none).toContain('No usage readings yet')
  expect(none).toContain('Blocking is not active.')
})

test('the ui command opens the panel and changes nothing', () => {
  for (const word of ['ui', 'UI', 'panel', 'open']) expect(parseCommand(word)).toEqual({ kind: 'ui' })
  const applied = applyCommand({ kind: 'ui' }, { warnAt: 70 }, DEFAULTS)
  expect(applied).toEqual({ overrides: { warnAt: 70 }, changed: false, message: null })
})

test('the meter fills in proportion and always has the same width', () => {
  expect(meter(0, 10)).toBe('░'.repeat(10))
  expect(meter(50, 10)).toBe('█'.repeat(5) + '░'.repeat(5))
  expect(meter(100, 10)).toBe('█'.repeat(10))
  expect(meter(250, 10)).toBe('█'.repeat(10))
  expect(meter(-5, 10)).toBe('░'.repeat(10))
  expect(Array.from(meter(83)).length).toBe(20)
})

test('a panel step stays within 1 to 100', () => {
  expect(stepped(80, 5)).toBe(85)
  expect(stepped(98, 5)).toBe(100)
  expect(stepped(3, -5)).toBe(1)
})
