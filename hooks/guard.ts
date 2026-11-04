// usage-guard logic: readings, thresholds, notices, the block decision and the /usage-guard command.
// Pure functions only: no engine calls, so every rule here is testable on its own.
import type { Flags, Overrides, Reading, WindowKind, WindowReading } from '../types'

export const KINDS: readonly WindowKind[] = ['five_hour', 'seven_day']
export const LABEL: Record<WindowKind, string> = { five_hour: '5-hour', seven_day: '7-day' }

// How long each window lasts. A reading with no reset time older than this cannot still be current.
const WINDOW_MS: Record<WindowKind, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }

export type Settings = { warnAt: number; blockAt: number; blockSubagents: boolean }
export const DEFAULTS: Settings = { warnAt: 80, blockAt: 95, blockSubagents: true }

/** One window, ready to judge at a given moment. */
export type WindowState = {
  kind: WindowKind
  percentUsed: number
  /** Epoch ms of the reset, or null when the engine gave none. */
  resetsAtMs: number | null
  /** The reading predates its own reset (or is older than the window): it says nothing about now. */
  expired: boolean
}

export type Notice = { type: 'warn' | 'cap'; window: WindowState }

// ---- readings ----

const isKind = (v: unknown): v is WindowKind => v === 'five_hour' || v === 'seven_day'

/** A window as the engine reports it, kept to percent used and reset time; null when unusable. */
function toWindow(v: unknown): WindowReading | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as { percentUsed?: unknown; resetsAt?: unknown }
  if (typeof o.percentUsed !== 'number' || !Number.isFinite(o.percentUsed)) return null
  const w: WindowReading = { percentUsed: Math.min(100, Math.max(0, o.percentUsed)) }
  if (typeof o.resetsAt === 'string' && Number.isFinite(Date.parse(o.resetsAt))) w.resetsAt = o.resetsAt
  return w
}

/** The engine's rate-limit list reduced to the two windows kept; null when it holds neither. */
export function pickReading(items: unknown, observedAt: number): Reading | null {
  if (!Array.isArray(items)) return null
  const out: Reading = { observedAt }
  for (const it of items as unknown[]) {
    if (typeof it !== 'object' || it === null) continue
    const kind = (it as { kind?: unknown }).kind
    if (!isKind(kind)) continue
    const w = toWindow(it)
    if (w !== null) out[kind] = w
  }
  return out.five_hour !== undefined || out.seven_day !== undefined ? out : null
}

/** A stored reading read back; null when it is missing or malformed. */
export function parseReading(v: unknown): Reading | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as { observedAt?: unknown }
  if (typeof o.observedAt !== 'number' || !Number.isFinite(o.observedAt)) return null
  const out: Reading = { observedAt: o.observedAt }
  for (const kind of KINDS) {
    const w = toWindow((v as Record<string, unknown>)[kind])
    if (w !== null) out[kind] = w
  }
  return out.five_hour !== undefined || out.seven_day !== undefined ? out : null
}

export function windowState(reading: Reading, kind: WindowKind, now: number): WindowState | null {
  const w = reading[kind]
  if (w === undefined) return null
  const parsed = w.resetsAt === undefined ? Number.NaN : Date.parse(w.resetsAt)
  const resetsAtMs = Number.isFinite(parsed) ? parsed : null
  const expired = resetsAtMs !== null ? resetsAtMs <= now : now - reading.observedAt >= WINDOW_MS[kind]
  return { kind, percentUsed: w.percentUsed, resetsAtMs, expired }
}

/** Every window the reading holds, judged at `now`. */
export function statesOf(reading: Reading | null, now: number): WindowState[] {
  if (reading === null) return []
  const out: WindowState[] = []
  for (const kind of KINDS) {
    const s = windowState(reading, kind, now)
    if (s !== null) out.push(s)
  }
  return out
}

// Two reset times closer than this belong to one window; further apart, to two different ones.
const SAME_WINDOW_MS = 10 * 60_000

/** Whether two readings of one window kind describe the same window (a missing reset time counts as the same). */
function sameWindow(a: WindowReading, b: WindowReading): boolean {
  if (a.resetsAt === undefined || b.resetsAt === undefined) return true
  return Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) < SAME_WINDOW_MS
}

/** Of two readings of different windows, the one whose window ends later is the newer window. */
const laterReset = (a: WindowReading, b: WindowReading): WindowReading => (Date.parse(b.resetsAt ?? '') > Date.parse(a.resetsAt ?? '') ? b : a)

/**
 * Two readings of the same account (this session's last response, and the one another session
 * stored) folded into one. Usage only climbs inside a window, so per window the higher percent
 * of the same window is the newer knowledge; if they are different windows the later one wins;
 * a window that has reset is dropped.
 */
export function mergeReadings(a: Reading | null, b: Reading | null, now: number): Reading | null {
  if (a === null || b === null) return a ?? b
  const out: Reading = { observedAt: Math.max(a.observedAt, b.observedAt) }
  for (const kind of KINDS) {
    const sa = windowState(a, kind, now)
    const sb = windowState(b, kind, now)
    const wa = a[kind]
    const wb = b[kind]
    const liveA = sa !== null && !sa.expired && wa !== undefined
    const liveB = sb !== null && !sb.expired && wb !== undefined
    if (liveA && liveB) out[kind] = sameWindow(wa, wb) ? (wb.percentUsed > wa.percentUsed ? wb : wa) : laterReset(wa, wb)
    else if (liveA) out[kind] = wa
    else if (liveB) out[kind] = wb
    else if (wa !== undefined && a.observedAt >= b.observedAt) out[kind] = wa
    else if (wb !== undefined) out[kind] = wb
    else if (wa !== undefined) out[kind] = wa
  }
  return out
}

// ---- settings ----

const inRange = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 100

/** Stored overrides read back, keeping only valid fields. */
export function parseOverrides(v: unknown): Overrides {
  const out: Overrides = {}
  if (typeof v !== 'object' || v === null) return out
  const o = v as Record<string, unknown>
  if (inRange(o.warnAt)) out.warnAt = o.warnAt
  if (inRange(o.blockAt)) out.blockAt = o.blockAt
  if (typeof o.blockSubagents === 'boolean') out.blockSubagents = o.blockSubagents
  return out
}

export type Resolved = { settings: Settings; overridden: (keyof Overrides)[]; notes: string[] }

/** Effective settings: a `/usage-guard` change wins, then the plugin option, then the default. */
export function resolveSettings(options: Readonly<Record<string, unknown>>, overrides: Overrides): Resolved {
  const overridden: (keyof Overrides)[] = []
  const pick = <K extends keyof Overrides & keyof Settings>(key: K, fromOption: Settings[K] | null): Settings[K] => {
    if (overrides[key] !== undefined) {
      overridden.push(key)
      return overrides[key] as Settings[K]
    }
    return fromOption ?? DEFAULTS[key]
  }
  const num = (v: unknown): number | null => (inRange(v) ? v : null)
  const warnAt = pick('warnAt', num(options.warnAt))
  const blockAt = pick('blockAt', num(options.blockAt))
  const blockSubagents = pick('blockSubagents', typeof options.blockSubagents === 'boolean' ? options.blockSubagents : null)
  const notes: string[] = []
  const settings: Settings = { warnAt, blockAt, blockSubagents }
  if (warnAt > blockAt) {
    settings.warnAt = blockAt
    notes.push(`Warn level (${pct(warnAt)}) was above the cap, so it is held at the cap (${pct(blockAt)}).`)
  }
  return { settings, overridden, notes }
}

// ---- the command ----

export type Command =
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'ui' }
  | { kind: 'reset' }
  | { kind: 'warn'; value: number }
  | { kind: 'cap'; value: number }
  | { kind: 'block'; on: boolean }
  | { kind: 'error'; message: string }

function parsePercent(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number(raw.replace(/%$/, ''))
  return inRange(n) ? n : null
}

export function parseCommand(args: string): Command {
  const t = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const head = t[0]
  if (head === undefined || head === 'status' || head === 'show') return { kind: 'status' }
  if (head === 'help' || head === '--help' || head === '-h' || head === '?') return { kind: 'help' }
  if (head === 'ui' || head === 'panel' || head === 'open') return { kind: 'ui' }
  if (head === 'reset') return { kind: 'reset' }
  if (head === 'warn' || head === 'cap') {
    const value = parsePercent(t[1])
    if (value === null) return { kind: 'error', message: `"${head}" needs a percent from 1 to 100, for example: /usage-guard ${head} ${head === 'warn' ? 80 : 95}` }
    return { kind: head, value }
  }
  if (head === 'block') {
    if (t[1] === 'on') return { kind: 'block', on: true }
    if (t[1] === 'off') return { kind: 'block', on: false }
    return { kind: 'error', message: '"block" needs on or off, for example: /usage-guard block off' }
  }
  return { kind: 'error', message: `Unknown option "${head}".` }
}

export type Applied = { overrides: Overrides; changed: boolean; message: string | null }

/** The overrides after a command, and the line saying what happened. Status and help change nothing. */
export function applyCommand(cmd: Command, overrides: Overrides, current: Settings): Applied {
  const keep = (message: string | null): Applied => ({ overrides, changed: false, message })
  switch (cmd.kind) {
    case 'status':
    case 'help':
    case 'ui':
      return keep(null)
    case 'error':
      return keep(`${cmd.message} Nothing was changed.`)
    case 'reset':
      return { overrides: {}, changed: Object.keys(overrides).length > 0, message: 'Command changes cleared; using the plugin options and defaults.' }
    case 'warn':
      if (cmd.value > current.blockAt) {
        return keep(`The warn level (${pct(cmd.value)}) cannot be above the cap (${pct(current.blockAt)}). Lower the cap first. Nothing was changed.`)
      }
      return { overrides: { ...overrides, warnAt: cmd.value }, changed: true, message: `Warn level set to ${pct(cmd.value)} used.` }
    case 'cap':
      if (cmd.value < current.warnAt) {
        return keep(`The cap (${pct(cmd.value)}) cannot be below the warn level (${pct(current.warnAt)}). Lower the warn level first. Nothing was changed.`)
      }
      return { overrides: { ...overrides, blockAt: cmd.value }, changed: true, message: `Cap set to ${pct(cmd.value)} used.` }
    case 'block':
      return {
        overrides: { ...overrides, blockSubagents: cmd.on },
        changed: true,
        message: cmd.on ? 'Blocking turned on: new subagents are refused at the cap.' : 'Blocking turned off: warnings only, nothing is refused.',
      }
  }
}

// ---- flags, notices and the block decision ----

export const freshFlags = (): Flags => ({
  warn: { five_hour: false, seven_day: false },
  cap: { five_hour: false, seven_day: false },
})

/** Stored flags read back; anything malformed starts over. */
export function parseFlags(v: unknown): Flags {
  const out = freshFlags()
  if (typeof v !== 'object' || v === null) return out
  const o = v as { warn?: unknown; cap?: unknown }
  for (const level of ['warn', 'cap'] as const) {
    const m = o[level]
    if (typeof m !== 'object' || m === null) continue
    for (const kind of KINDS) out[level][kind] = (m as Record<string, unknown>)[kind] === true
  }
  return out
}

/**
 * Which notices a reading earns, and the flags afterwards. Each climb speaks once per level:
 * a window crossing the warn level warns; one crossing the cap says so (and a jump straight past
 * both gives only the cap notice). A window that falls back under a level, or whose reading has
 * expired, is armed again. A window the reading does not hold keeps its flags.
 */
export function evaluate(states: readonly WindowState[], flags: Flags, s: Settings): { flags: Flags; notices: Notice[] } {
  const next: Flags = { warn: { ...flags.warn }, cap: { ...flags.cap } }
  const notices: Notice[] = []
  for (const w of states) {
    const k = w.kind
    if (w.expired) {
      next.warn[k] = false
      next.cap[k] = false
    } else if (w.percentUsed >= s.blockAt) {
      if (!next.cap[k]) notices.push({ type: 'cap', window: w })
      next.cap[k] = true
      next.warn[k] = true
    } else if (w.percentUsed >= s.warnAt) {
      if (!next.warn[k]) notices.push({ type: 'warn', window: w })
      next.warn[k] = true
      next.cap[k] = false
    } else {
      next.warn[k] = false
      next.cap[k] = false
    }
  }
  return { flags: next, notices }
}

/** Windows that currently forbid a new subagent: not expired, at or above the cap, blocking on. */
export function blockers(states: readonly WindowState[], s: Settings): WindowState[] {
  if (!s.blockSubagents) return []
  return states.filter(w => !w.expired && w.percentUsed >= s.blockAt)
}

/** Windows at or above the cap whether or not blocking is on. */
export const overCap = (states: readonly WindowState[], s: Settings): WindowState[] => states.filter(w => !w.expired && w.percentUsed >= s.blockAt)

// ---- text ----

/** A text meter, `cells` wide: 83% of 20 is 17 filled cells. The percent is always written beside it by the caller. */
export function meter(percent: number, cells = 20): string {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

/** How far one press of a panel button moves the warn level or the cap. */
export const PANEL_STEP = 5

/** `value` moved by `delta`, kept to 1..100 (the range the settings take). */
export const stepped = (value: number, delta: number): number => Math.min(100, Math.max(1, Math.round(value + delta)))

/** 83 -> "83%", 83.5 -> "83.5%". */
export function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`
}

/** Whole minutes, hours or days: "under a minute", "47m", "1h 12m", "3d 4h". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number): string => String(n).padStart(2, '0')

/** Local wall-clock time of a reset: "14:30", with the weekday when it is more than 18 hours away. */
export function formatClock(ms: number, now: number): string {
  const d = new Date(ms)
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return ms - now > 18 * 3_600_000 ? `${DAYS[d.getDay()] ?? ''} ${hm}` : hm
}

/** "resets in 1h 12m (14:30)", or "reset time unknown". */
export function resetText(w: WindowState, now: number): string {
  if (w.resetsAtMs === null) return 'reset time unknown'
  return `resets in ${formatDuration(w.resetsAtMs - now)} (${formatClock(w.resetsAtMs, now)})`
}

/** "5m ago" / "just now". */
const ago = (ms: number): string => (ms < 60_000 ? 'just now' : `${formatDuration(ms)} ago`)

export function noticeText(n: Notice, s: Settings, now: number): string {
  const w = n.window
  const head = `usage-guard: ${LABEL[w.kind]} usage is at ${pct(w.percentUsed)}`
  if (n.type === 'warn') return `${head} (warning at ${pct(s.warnAt)}); ${resetText(w, now)}.`
  if (!s.blockSubagents) return `${head}, at or above your ${pct(s.blockAt)} cap. Subagent blocking is off, so nothing is refused; ${resetText(w, now)}.`
  return `${head}, at or above your ${pct(s.blockAt)} cap. New subagents are blocked until the window resets; ${resetText(w, now)}.`
}

/** What the Agent tool shows the model when a spawn is refused. */
export function blockReason(hit: readonly WindowState[], s: Settings, now: number): string {
  const tail = 'Carry on in the main thread, or wait for the reset. The person can change this with /usage-guard.'
  const only = hit.length === 1 ? hit[0] : undefined
  if (only !== undefined) {
    return `usage-guard blocked this subagent: ${LABEL[only.kind]} usage is at ${pct(only.percentUsed)}, at or above the ${pct(s.blockAt)} cap, and ${resetText(only, now)}. New subagents stay blocked until then. ${tail}`
  }
  const lines = hit.map(w => `- ${LABEL[w.kind]}: ${pct(w.percentUsed)} used, ${resetText(w, now)}`)
  return `usage-guard blocked this subagent: usage is at or above the ${pct(s.blockAt)} cap in more than one window.\n${lines.join('\n')}\nNew subagents stay blocked until every window above has reset. ${tail}`
}

/** The pinned status line while blocking is active. */
export function statusLine(hit: readonly WindowState[], s: Settings, now: number): string {
  const parts = hit.map(w => `${LABEL[w.kind]} ${pct(w.percentUsed)}${w.resetsAtMs === null ? '' : `, resets ${formatClock(w.resetsAtMs, now)}`}`)
  return `usage-guard: new subagents blocked (cap ${pct(s.blockAt)}) - ${parts.join('; ')}`
}

/** Earliest moment a blocker resets, or null when none gives a reset time. */
export function nextClear(hit: readonly WindowState[]): number | null {
  let t: number | null = null
  for (const w of hit) if (w.resetsAtMs !== null && (t === null || w.resetsAtMs < t)) t = w.resetsAtMs
  return t
}

export const HELP = [
  'Commands:',
  '  /usage-guard                 this readout',
  '  /usage-guard ui              open the usage panel (live meters, buttons for the settings)',
  '  /usage-guard warn <1-100>    warn when a window reaches this percent used',
  '  /usage-guard cap <1-100>     block new subagents at or above this percent used',
  '  /usage-guard block on|off    refuse new subagents at the cap, or warn only',
  '  /usage-guard reset           drop these changes and use the plugin options',
].join('\n')

/** The /usage-guard readout. */
export function commandText(i: {
  reading: Reading | null
  settings: Settings
  overridden: readonly (keyof Overrides)[]
  notes: readonly string[]
  now: number
}): string {
  const { reading, settings: s, now } = i
  const states = statesOf(reading, now)
  const lines: string[] = ['Usage limits']
  if (reading === null) {
    lines.push('No usage readings yet. They arrive with Claude responses on a Claude subscription (API-key sessions report none).')
  } else {
    for (const kind of KINDS) {
      const w = states.find(x => x.kind === kind)
      const label = LABEL[kind].padEnd(7)
      if (w === undefined) lines.push(`${label} no reading`)
      else if (w.expired) lines.push(`${label} last read ${pct(w.percentUsed)}, but that window has reset; waiting for a new reading`)
      else lines.push(`${label} ${pct(w.percentUsed)} used, ${resetText(w, now)}`)
    }
    lines.push(`Last reading: ${ago(now - reading.observedAt)}.`)
  }
  lines.push('')
  lines.push(`Warn at ${pct(s.warnAt)} used. Cap ${pct(s.blockAt)} used. Blocking new subagents: ${s.blockSubagents ? 'on' : 'off'}.`)
  const hit = blockers(states, s)
  const over = overCap(states, s)
  if (hit.length > 0) {
    lines.push(`Blocking is ACTIVE: ${hit.map(w => `${LABEL[w.kind]} at ${pct(w.percentUsed)}`).join(', ')}.`)
    lines.push('New subagents are refused until the window resets. Your own prompts and the main thread are not affected.')
  } else if (over.length > 0) {
    lines.push(`Blocking is off, though ${over.map(w => LABEL[w.kind]).join(' and ')} is at or above the cap, so nothing is refused.`)
  } else {
    lines.push('Blocking is not active.')
  }
  if (i.overridden.length > 0) lines.push(`Changed with this command: ${i.overridden.join(', ')} (run /usage-guard reset to undo).`)
  for (const n of i.notes) lines.push(n)
  lines.push('')
  lines.push(HELP)
  return lines.join('\n')
}
