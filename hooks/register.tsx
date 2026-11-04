// usage-guard wiring. The rules live in ./guard (pure and tested); this file only connects them to the engine.
//
// What it uses, all from the mod API's own types:
//   session.measure  the 5-hour / 7-day readings the engine pushes after each response
//   agent.spawn      the one hook that can refuse a subagent before it starts ({ deny })
//   command.run      the /usage-guard command
// It makes no network calls and reads no files. It keeps one thing on disk: the last reading.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Overrides, Reading } from '../types'
import {
  applyCommand,
  blockReason,
  blockers,
  commandText,
  evaluate,
  freshFlags,
  HELP,
  KINDS,
  LABEL,
  mergeReadings,
  meter,
  nextClear,
  noticeText,
  PANEL_STEP,
  parseCommand,
  parseFlags,
  parseOverrides,
  parseReading,
  pct,
  pickReading,
  resetText,
  resolveSettings,
  statesOf,
  statusLine,
  stepped,
} from './guard'
import type { Applied, Command, Resolved, Settings } from './guard'

type $T = EngineInterface

const READING = 'reading'
const OVERRIDES = 'overrides'
const PANE = 'usage-guard'

const flagsA = atom({ plugin: 'usage-guard', key: 'flags' } as const, freshFlags())
// What an open panel draws from. The panel reads both while drawing, so a write to either redraws it.
const tickA = atom({ plugin: 'usage-guard', key: 'tick' } as const, 0)
const noteA = atom({ plugin: 'usage-guard', key: 'note' } as const, '')

// Plugin options as loaded (a change in the config menu reloads the module with new ones).
let options: Readonly<Record<string, unknown>> = {}
let timer: Timer | null = null

// Debug log: where it failed and the error's name only (a message can hold a path).
const errName = (err: unknown): string => (err instanceof Error ? err.name : 'non-error')
function log($: $T, where: string, err?: unknown): void {
  try {
    $.ui.log(`usage-guard: ${where}${err === undefined ? '' : ' failed: ' + errName(err)}`, { to: 'debug' })
  } catch {
    // logging is best effort
  }
}

/** A line the person should see: kept in the transcript, and shown as a toast. */
function say($: $T, text: string): void {
  try {
    $.ui.log(text)
  } catch (err) {
    log($, 'say log', err)
  }
  try {
    $.ui.toast(text, { timeoutMs: 10_000 })
  } catch (err) {
    log($, 'say toast', err)
  }
}

async function loadSettings($: $T): Promise<Resolved> {
  const overrides: Overrides = parseOverrides(await $.store.get(OVERRIDES))
  return resolveSettings(options, overrides)
}

/**
 * The best reading there is right now: the engine's own latest figures for this session
 * merged with the one stored (which another session may have written more recently).
 */
async function currentReading($: $T, now: number): Promise<Reading | null> {
  let live: Reading | null = null
  try {
    live = pickReading((await $.session.usage()).rateLimits, now)
  } catch (err) {
    log($, 'usage', err)
  }
  return mergeReadings(live, parseReading(await $.store.get(READING)), now)
}

/** Pin or clear the status line, and arm one timer to clear it when the first blocker resets. */
async function refreshStatus($: $T): Promise<void> {
  const now = await $.clock.now()
  const { settings } = await loadSettings($)
  const reading = parseReading(await $.store.get(READING))
  const hit = blockers(statesOf(reading, now), settings)
  timer?.cancel()
  timer = null
  if (hit.length === 0) {
    $.ui.status(undefined)
    return
  }
  $.ui.status(statusLine(hit, settings, now))
  const clearAt = nextClear(hit)
  if (clearAt !== null) {
    timer = $.clock.after(Math.max(1000, clearAt - now + 1000), () => {
      void refreshStatus($).catch(err => log($, 'status timer', err))
    })
  }
}

async function onMeasure($: $T, rateLimits: unknown): Promise<void> {
  const now = await $.clock.now()
  const fresh = pickReading(rateLimits, now)
  if (fresh === null) return
  // The only thing kept on disk: the last reading, folded with a newer one another session stored.
  const merged = mergeReadings(fresh, parseReading(await $.store.get(READING)), now) ?? fresh
  await $.store.set(READING, merged)

  const { settings } = await loadSettings($)
  const before = parseFlags(await read($, flagsA))
  const { flags, notices } = evaluate(statesOf(merged, now), before, settings)
  await update($, flagsA, () => flags)
  for (const n of notices) say($, noticeText(n, settings, now))
  await refreshStatus($)
  await bump($)
}

/** Ask an open panel to redraw (a no-op when none is open). */
async function bump($: $T): Promise<void> {
  try {
    await update($, tickA, n => n + 1)
  } catch (err) {
    log($, 'panel redraw', err)
  }
}

/** Save what a command changed, and bring the status line in line with it. */
async function commit($: $T, applied: Applied): Promise<void> {
  if (!applied.changed) return
  if (Object.keys(applied.overrides).length === 0) await $.store.delete(OVERRIDES)
  else await $.store.set(OVERRIDES, applied.overrides)
  try {
    await refreshStatus($)
  } catch (err) {
    log($, 'command status', err)
  }
}

/** A panel button: build the command from the settings in force right now (not those at draw time), apply it, redraw. */
async function press($: $T, make: (s: Settings) => Command): Promise<void> {
  try {
    const stored = parseOverrides(await $.store.get(OVERRIDES))
    const { settings } = resolveSettings(options, stored)
    const applied = applyCommand(make(settings), stored, settings)
    await commit($, applied)
    await update($, noteA, () => applied.message ?? '')
  } catch (err) {
    log($, 'panel press', err)
  }
  await bump($)
}

/** The reason to refuse a new subagent right now, or null to let it start. */
async function blockNow($: $T): Promise<string | null> {
  const now = await $.clock.now()
  const { settings } = await loadSettings($)
  if (!settings.blockSubagents) return null
  const hit = blockers(statesOf(await currentReading($, now), now), settings)
  return hit.length === 0 ? null : blockReason(hit, settings, now)
}

async function runCommand($: $T, args: string | undefined): Promise<string> {
  const cmd = parseCommand(args ?? '')
  if (cmd.kind === 'help') return HELP
  const now = await $.clock.now()
  const stored = parseOverrides(await $.store.get(OVERRIDES))
  const before = resolveSettings(options, stored)
  const applied = applyCommand(cmd, stored, before.settings)
  await commit($, applied)
  if (applied.changed) await bump($)
  const after = applied.changed ? resolveSettings(options, applied.overrides) : before
  const readout = commandText({
    reading: await currentReading($, now),
    settings: after.settings,
    overridden: after.overridden,
    notes: after.notes,
    now,
  })
  return applied.message === null ? readout : `${applied.message}\n\n${readout}`
}

export const register: Register = (on, opts) => {
  options = opts
  timer?.cancel()
  timer = null

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({
        name: 'usage-guard',
        description: 'Show 5-hour and 7-day usage, the warn level and cap, and whether new subagents are blocked',
        argumentHint: '[ui | warn <n> | cap <n> | block on|off | reset]',
      })
    } catch (err) {
      log($, 'session.start command register', err)
    }
    try {
      await refreshStatus($)
    } catch (err) {
      log($, 'session.start status', err)
    }
    return r
  })

  // Readings arrive here: after each main-thread turn, and whenever a window moves a whole point.
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    try {
      await onMeasure($, e.rateLimits)
    } catch (err) {
      log($, 'session.measure', err)
    }
    return r
  })

  // The block. agent.spawn fires before a subagent, teammate or workflow agent starts; { deny } refuses it
  // and the text becomes the Agent tool's error. Resuming an existing subagent is not a new spawn and passes.
  // A bug here must never take subagents away, so any failure lets the spawn through.
  on('agent.spawn', async ($, e, next) => {
    if (e.resume === undefined) {
      try {
        const reason = await blockNow($)
        if (reason !== null) {
          try {
            $.ui.toast('usage-guard: a new subagent was blocked, usage is at the cap. /usage-guard for details.', { timeoutMs: 8000 })
          } catch (err) {
            log($, 'agent.spawn toast', err)
          }
          return { deny: reason }
        }
      } catch (err) {
        log($, 'agent.spawn check', err)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Answers its own command only; never reads next.
  on('command.run', { command: 'usage-guard' }, async ($, e) => {
    let text = 'usage-guard: could not produce a readout.'
    try {
      if (parseCommand(e.args ?? '').kind === 'ui') {
        const opened = await $.ui.open({ id: PANE, title: 'Usage guard', focus: true, closeOnEscape: true })
        if (opened.isPlaced) {
          await bump($)
          return { text: 'usage-guard: panel opened. Press Esc to close it.' }
        }
        text = `usage-guard: the panel could not open here (${opened.reason}). The readout instead:\n\n${await runCommand($, '')}`
      } else {
        text = await runCommand($, e.args)
      }
    } catch (err) {
      log($, 'command.run readout', err)
    }
    return { text }
  })

  // The panel: live meters for both windows, the settings, and buttons to change them.
  // Everything is read fresh while drawing; the atoms are read so a change redraws it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, tickA)
    const note = await read($, noteA)
    const now = await $.clock.now()
    const { settings: s, overridden } = await loadSettings($)
    const states = statesOf(await currentReading($, now), now)
    const hit = blockers(states, s)
    const cells = Math.max(10, Math.min(30, (e.props.bodyColumns ?? 60) - 34))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {KINDS.map(kind => {
            const w = states.find(x => x.kind === kind)
            const label = LABEL[kind].padEnd(7)
            if (w === undefined || w.expired) {
              return <Text dimColor>{label} {w === undefined ? 'no reading yet' : `last read ${pct(w.percentUsed)}, window has reset; waiting for a new reading`}</Text>
            }
            const state = w.percentUsed >= s.blockAt ? 'at cap' : w.percentUsed >= s.warnAt ? 'warning' : 'ok'
            const color = state === 'at cap' ? 'error' : state === 'warning' ? 'warning' : 'success'
            return (
              <Text>
                {label} <Text color={color}>{meter(w.percentUsed, cells)}</Text> {pct(w.percentUsed).padStart(5)} {state.padEnd(7)}
                <Text dimColor> {resetText(w, now)}</Text>
              </Text>
            )
          })}
        </Box>
        <Box flexDirection="column">
          <Text>
            Warn at {pct(s.warnAt)}, cap {pct(s.blockAt)}. New subagents:{' '}
            {hit.length > 0 ? 'BLOCKED now' : s.blockSubagents ? 'allowed (blocked at the cap)' : 'never blocked (warnings only)'}.
          </Text>
          {overridden.length > 0 && <Text dimColor>Changed here or with /usage-guard: {overridden.join(', ')}.</Text>}
          {note !== '' && <Text color="warning">{note}</Text>}
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="warn-down" hotkey="1" label={`1 Warn -${PANEL_STEP}`} onPress={() => press($, c => ({ kind: 'warn', value: stepped(c.warnAt, -PANEL_STEP) }))} />
          <Button key="warn-up" hotkey="2" label={`2 Warn +${PANEL_STEP}`} onPress={() => press($, c => ({ kind: 'warn', value: stepped(c.warnAt, PANEL_STEP) }))} />
          <Button key="cap-down" hotkey="3" label={`3 Cap -${PANEL_STEP}`} onPress={() => press($, c => ({ kind: 'cap', value: stepped(c.blockAt, -PANEL_STEP) }))} />
          <Button key="cap-up" hotkey="4" label={`4 Cap +${PANEL_STEP}`} onPress={() => press($, c => ({ kind: 'cap', value: stepped(c.blockAt, PANEL_STEP) }))} />
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="block" hotkey="5" label={s.blockSubagents ? '5 Turn blocking off' : '5 Turn blocking on'} onPress={() => press($, c => ({ kind: 'block', on: !c.blockSubagents }))} />
          <Button key="reset" hotkey="6" label="6 Reset to defaults" onPress={() => press($, () => ({ kind: 'reset' }))} />
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
