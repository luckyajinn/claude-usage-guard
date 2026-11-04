// Shared data types for usage-guard. Type exports only.

/** The two rate-limit windows the guard watches. Any other kind the engine reports is ignored. */
export type WindowKind = 'five_hour' | 'seven_day'

/** One window as last read: percent used (0-100) and, when the engine gave it, the reset time (ISO 8601). */
export type WindowReading = { percentUsed: number; resetsAt?: string }

/** The last reading, with the epoch ms it was observed. This is the only usage data the mod keeps. */
export type Reading = { observedAt: number; five_hour?: WindowReading; seven_day?: WindowReading }

/** Settings changed with `/usage-guard`. A field that is absent falls back to the plugin option. */
export type Overrides = { warnAt?: number; blockAt?: number; blockSubagents?: boolean }

/** Per window: has the warning (warn level) or the cap notice (cap level) already been shown for this climb? */
export type Flags = { warn: Record<WindowKind, boolean>; cap: Record<WindowKind, boolean> }

declare module 'claude-code' {
  interface PluginState {
    'usage-guard': {
      /** Session memory of which notices were shown, so each threshold crossing speaks once. */
      flags: Flags
      /** Bumped whenever the panel's figures may have changed, so an open panel redraws. */
      tick: number
      /** The last line a panel button produced (for example a refused change); empty when none. */
      note: string
    }
  }
}
