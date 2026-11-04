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
  mergeReadings,
  nextClear,
  noticeText,
  parseCommand,
  parseFlags,
  parseOverrides,
  parseReading,
  pickReading,
  resolveSettings,
  statesOf,
  statusLine,
} from './guard'
import type { Resolved } from './guard'

type $T = EngineInterface

const READING = 'reading'
const OVERRIDES = 'overrides'

const flagsA = atom({ plugin: 'usage-guard', key: 'flags' } as const, freshFlags())

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
  if (applied.changed) {
    if (Object.keys(applied.overrides).length === 0) await $.store.delete(OVERRIDES)
    else await $.store.set(OVERRIDES, applied.overrides)
    try {
      await refreshStatus($)
    } catch (err) {
      log($, 'command status', err)
    }
  }
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
        argumentHint: '[warn <n> | cap <n> | block on|off | reset]',
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
      text = await runCommand($, e.args)
    } catch (err) {
      log($, 'command.run readout', err)
    }
    return { text }
  })
}
