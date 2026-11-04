# usage-guard

A Claude Code mod that watches your 5-hour and 7-day usage limits, warns you as they climb, and refuses to start new subagents when you are near the cap.

- Tracks percent used and reset time for the 5-hour and 7-day windows.
- Warns once when a window reaches your warn level (default 80% used), with the time until it resets.
- Blocks new subagents when a window reaches your cap (default 95% used). The message says which window, how full it is and when it resets.
- `/usage-guard` prints the readings, the thresholds and whether blocking is active, and lets you change the thresholds.

```
usage-guard: 5-hour usage is at 83% (warning at 80%); resets in 1h 12m (14:30).
```

```
usage-guard blocked this subagent: 5-hour usage is at 96%, at or above the 95% cap, and resets in 1h 12m (14:30). New subagents stay blocked until then. Carry on in the main thread, or wait for the reset. The person can change this with /usage-guard.
```

## Install

Needs Claude Code with mod support and a Claude subscription (rate limits are not reported on API keys, so there is nothing to guard on one).

From a terminal (PowerShell, bash or zsh):

```
claude plugin marketplace add luckyajinn/claude-usage-guard
claude plugin install usage-guard@claude-usage-guard --scope user
```

Then start a new session.

## What it does

### Warnings

Every response, Claude Code reports your usage. When a window reaches the warn level, usage-guard shows one line as a toast and keeps the same line in the transcript. It then stays quiet for that window until it falls back under the level (the window reset) and climbs again. Crossing the cap speaks once more. A jump straight past both levels gives only the cap message. If you start a session already above the warn level, the first reading of that session warns once.

### Blocking new subagents

When a window is at or above the cap, the mod refuses to start a new subagent. Claude sees the refusal as the Agent tool's error, with the reason and the reset time, and carries on in the main thread. While blocking is active, a status line under the prompt says so, and it clears when the window resets.

This uses the `agent.spawn` hook of the mod API, which runs before a subagent starts and can refuse it. It covers subagents started through the Agent tool, teammates, workflow agents and subagents that other plugins start.

### `/usage-guard`

```
/usage-guard                 readings, thresholds, blocking state
/usage-guard ui              open the usage panel
/usage-guard warn <1-100>    warn when a window reaches this percent used
/usage-guard cap <1-100>     block new subagents at or above this percent used
/usage-guard block on|off    refuse new subagents at the cap, or warn only
/usage-guard reset           drop these changes and use the plugin options
```

### The usage panel

`/usage-guard ui` opens a panel with a meter for each window (the percent and a word - ok, warning or at cap - are written beside it, never color alone), the reset times, the warn level and cap, and whether new subagents are blocked right now. Buttons change the warn level and the cap in steps of 5, turn blocking on or off, and reset to the plugin options; keys 1 to 6 press them, and Esc closes the panel. The panel redraws as new readings arrive, and anything changed there is the same as changing it with the commands below (it is kept on your machine and applies to every session). A change that would put the warn level above the cap is refused with the reason shown in the panel. Where the panel cannot open (for example no screen attached), the command prints the text readout instead.

The warn level cannot be set above the cap, or the cap below the warn level; the command says so and changes nothing. Changes are kept on your machine and apply to every session.

## Options

| Option | Default | Meaning |
|---|---|---|
| `warnAt` | 80 | Percent used at which a window warns (1 to 100) |
| `blockAt` | 95 | Percent used at which new subagents are refused (1 to 100) |
| `blockSubagents` | on | Off means warnings only; nothing is ever refused |

Set them with `/plugin configure usage-guard@claude-usage-guard` in a terminal session, or `claude plugin configure usage-guard@claude-usage-guard` from a shell (it lists the options and which are unset). A change made with `/usage-guard` wins over the option until you run `/usage-guard reset`.

## Honest limits

- **It only knows what Claude Code reports.** Readings arrive after each response, as whole-point moves, so a figure can be a response or two old. It is not a live meter. Usage is account-wide, so another session or device can push you over the cap without this session seeing it until its next response (readings other sessions of this mod stored on your machine are used, which helps only on the same computer).
- **It cannot stop a running subagent, or your own turns.** Blocking applies at the moment a subagent starts. Subagents already running keep running, resuming an existing subagent is not blocked, and the main conversation, tools and your prompts are never blocked. A subagent started just under the cap can still carry you past it.
- **A refusal is advice the model receives, not a lock.** Claude gets an error and usually works in the main thread, but nothing here stops it using other tools. A plugin that sits above this one in a managed setup can also skip its hook.
- **It fails open.** If the guard hits an error of its own, the subagent starts and the error goes to the debug log, so a bug cannot take subagents away.
- **Only two windows.** The 5-hour and 7-day windows are used. Any other limit Claude Code reports (for example a gateway's spend limit) is ignored.
- **The mod API is early access.** It was written against the mod API types shipped with Claude Code 2.1.317 and its tests run with `claude plugin test` from 2.1.316. A future release can change or remove hooks; if `agent.spawn` goes away, blocking would stop working and only the warnings would remain.
- **Not tested here yet:** a live interactive session with real usage near the cap, the install route through the marketplace, the config menu's number fields, how the toast, status line and the `/usage-guard ui` panel look in the terminal, the desktop app and VS Code (the panel is tested in the mod test kit only), and running next to usage-hud. See Development for what is tested.

## Works with usage-hud

usage-guard does not need usage-hud and does not read its data. Both receive the same readings from Claude Code, keep separate stores and use different commands, so they can be installed together. usage-hud shows the numbers; usage-guard acts on them.

## What it stores

On your machine only, in the mod's own store: the last reading (percent used and reset time for each window, and when it was seen) and any thresholds you changed with `/usage-guard`. Nothing about prompts, files or tools. Which warnings were already shown is remembered for the session only. There are no network calls and no file access; `claude plugin validate .` lists the calls the module makes.

## Updating

```
claude plugin marketplace update claude-usage-guard
claude plugin update usage-guard@claude-usage-guard
```

Then start a new session.

## Uninstall

```
claude plugin uninstall usage-guard@claude-usage-guard --scope user
claude plugin marketplace remove claude-usage-guard
```

## Development

```
claude plugin validate .
claude plugin test .
```

The tests cover the threshold, warning and blocking rules (`hooks/guard.test.ts`) and the hooks end to end against the mod test kit (`hooks/register.test.ts`): a spawn refused at the cap and allowed below it, a resume passing, expired and stored readings, warn once per crossing, the commands, and failing open. The kit stands in for Claude Code, so it shows the mod answers `agent.spawn` with a refusal, not that a live session shows it the way this README describes.

MIT license.
