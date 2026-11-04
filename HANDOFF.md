# usage-guard: handoff

Written 2026-11-04 from the actual repo state (git, `claude plugin validate`, `claude plugin test`), so a fresh chat on another machine can continue cold. Read `README.md` for the user-facing docs; this file is for whoever works on the code next.

## 1. What it is

A Claude Code mod (plugin using the early-access hooks API) that tracks the 5-hour and 7-day usage windows, warns as they climb, and refuses to start new subagents near the cap. Plugin name `usage-guard` v0.1.0, MIT, author CJ. It needs a Claude subscription (API-key sessions report no rate limits, so it does nothing there). It makes no network calls and does not depend on usage-hud.

Today it does:
- **Track:** each `session.measure` event carries `rateLimits` (`five_hour`, `seven_day`, each with percent used and optional reset time). The mod keeps only the last reading, in `$.store`.
- **Warn:** one toast plus one transcript line per window when it reaches the warn level, with time until reset. Warns once per climb; re-armed when usage falls back under the level or the reading expires.
- **Block:** at or above the cap, the `agent.spawn` hook returns `{ deny: reason }`, so new subagents, teammates and workflow agents are refused with the window, percent and reset time. A status line is pinned while blocking and cleared at the reset. Resuming an existing subagent is not blocked.
- **Command `/usage-guard`:** with no argument prints readings, thresholds and blocking state. Arguments: `warn <1-100>`, `cap <1-100>`, `block on|off`, `reset` (drop command changes), `help`. A warn level above the cap, or a cap below the warn level, is refused and nothing changes.
- **Settings read** (plugin `userConfig`): `warnAt` (default 80), `blockAt` (default 95), `blockSubagents` (default true). Precedence: `/usage-guard` change (store key `overrides`), then plugin option, then default.

Not built: the popup dialog in `design/usage-popup/` is a mockup only (section 6).

## 2. Repo state (checked with git on 2026-11-04)

- GitHub: https://github.com/luckyajinn/claude-usage-guard (owner `luckyajinn`)
- Branch `main`, HEAD `0d8d5e8`, equal to `origin/main` (0 ahead, 0 behind; `git ls-remote` agrees).
- Commits, both pushed:
  - `db58c42` Initial release of usage-guard v0.1.0
  - `0d8d5e8` Add terminal usage-popup design mockups
- Uncommitted: this `HANDOFF.md`, and four untracked, deliberately uncommitted design variants in `design/usage-popup/` (`a-modal-*.svg`, `b-card-*.svg`; the unchosen modal and card designs). Delete or keep as you like.
- Not in the repo and not needed to resume: scratch tooling in a temp folder used for type-checking and mutation checks (recreate from section 4).

## 3. Verified and not verified

Verified today (CLI 2.1.317):
- `claude plugin validate .` passes. One optional warning: no plugin icon.
- `claude plugin test .` passes: 42 tests, 0 fail, across `hooks/guard.test.ts` (18, pure logic) and `hooks/register.test.ts` (24, hooks end to end in the mod test kit).
- Type-check clean (0 diagnostics) when last run, against the Claude Code 2.1.317 API types.
- Mutation checks: six deliberately broken rules (cap `>=` to `>`, resume blocked, warn every time, expired reading blocks, ignores the off switch, fails closed) were each caught by the tests.
- An earlier headless run (CLI 2.1.316, `claude -p "/usage-guard" --plugin-dir . --no-session-persistence`) loaded the mod, registered its four hooks and answered the command with defaults and no readings. A re-run today on 2.1.317 loaded the plugin directory and read `hooks.json` but then stopped at "OAuth session expired" (headless runs need a logged-in CLI); not a mod fault, and the readout was not re-obtained.

NOT verified:
- **It has never run in a live interactive Claude Code session**, so no real refusal at the cap, no real toast or status line, has been seen. Everything about behavior comes from the test kit and the types.
- Installing through the marketplace (`marketplace add` then `install`), and `claude plugin update`.
- The config menu's number fields (`claude plugin configure`).
- How the toast and status line look in the desktop app and VS Code.
- Running next to usage-hud.
- That `resetsAt` stays stable within a window (assumed; readings from the same window are matched within 10 minutes).
- Whether the real engine reports `rateLimits` on every response as assumed.

## 4. Set up on a new machine

Needs Claude Code with mod support (written against the 2.1.317 API; tests ran on 2.1.316 and 2.1.317).

```
git clone https://github.com/luckyajinn/claude-usage-guard
cd claude-usage-guard
claude plugin validate .
claude plugin test .
```

Try it locally without installing: `claude --plugin-dir .` from the repo, then run `/usage-guard`. Quick live-test recipe (not yet run): `/usage-guard warn 1`, then `/usage-guard cap 1`, then ask Claude to start a subagent; it should be refused once any usage is reported. Undo with `/usage-guard reset`.

Install from the marketplace (untested end to end):
```
claude plugin marketplace add luckyajinn/claude-usage-guard
claude plugin install usage-guard@claude-usage-guard --scope user
```
Update: `claude plugin marketplace update claude-usage-guard`, then `claude plugin update usage-guard@claude-usage-guard`, then start a new session. Installed copies are cached by plugin version (reported by the session that coordinates these mods; not verified here), so bump `version` in `.claude-plugin/plugin.json` before expecting `plugin update` to pick up changes. `marketplace.json` carries no version field.

On Windows `claude` may not be on PATH. It was found at `%USERPROFILE%\.local\bin\claude.exe` (2.1.316) and, newer, under the Claude desktop app's data folder (`Claude-Data\...\claude-code\<version>\<hash>\claude.exe`, 2.1.317). Call it by full path.

Type-checking: no `tsc` was installed. VS Code bundles TypeScript (`extensions\node_modules\typescript\lib\typescript.js`); drive it with a few lines of node (`createProgram` plus `getPreEmitDiagnostics`) and a tsconfig kept outside the repo whose `include` names the API types file, `hooks` and `types`. The repo `tsconfig.json` points at `.claude-plugin/types/`, which exists only after the engine has loaded the mod; once it has, `tsc -p .` works. The API types file is written by the plugin-authoring skill when it loads; treat it as the source of truth for what hooks exist.

## 5. Design decisions and why

Layout: `hooks/guard.ts` holds all rules as pure functions (readings, merge, settings, command parsing, warn/cap flags, text). `hooks/register.tsx` is thin wiring to the engine. Both have colocated tests. `types/index.d.ts` declares `PluginState['usage-guard'] = { flags }`, which `validate` checks.

Hooks used: `session.start` (registers the command, refreshes the status line), `session.measure` (calls `next` first, then stores and evaluates), `agent.spawn` (the gate), `command.run` with matcher `{ command: 'usage-guard' }`.

Choices:
- **Real blocking via `agent.spawn`.** It runs before a subagent starts, and the deny text becomes the Agent tool's error. The `agent.spawn` hook is wrapped with `.catch(($, e, next) => next(e))` and its own try/catch, so any internal error fails open (the spawn proceeds). A bug must never take subagents away.
- **Resumes pass** (`e.resume` set): a resume does not add a new agent.
- **Defaults 80 / 95.** Warn at 80% used, block at 95%. The cap is exact (94.9 starts, 95 blocks).
- **Readings merge, not replace.** Live `$.session.usage()` is merged with the stored reading. Same window (reset times within 10 minutes): higher percent wins. Different windows: the later reset wins. This lets other sessions on the same machine inform this one.
- **Expiry.** A reading is dead if `resetsAt <= now`, or, with no `resetsAt`, if older than the window length (5 hours or 7 days). Expired readings never warn or block, and re-arm the window.
- **Warning flags** live in `$.state` (session only). A jump straight past both levels gives only the cap notice.
- **A timer** (`$.clock.after`) clears the pinned status line at the first blocker's reset.
- **Only two windows.** `spend_limit` and anything else is ignored.
- **Privacy:** the store holds only the last reading and the command overrides. No prompts, files or tools.

Deliberately not done: stopping running subagents; blocking the main conversation or the user's prompts; any network call or file access; reading usage-hud's data.

Trade-offs: readings are only as fresh as the last response, usage is account-wide so another device can push past the cap unseen, and a refusal is advice to the model, not a lock.

## 6. Limitations, open questions, next steps (priority order)

1. **Run it in a live session** and confirm a real refusal, toast and status line (recipe in section 4). Biggest unknown.
2. **Test the marketplace install and update route**, including the version-bump caching note.
3. **Check co-install with usage-hud** and the config menu number fields.
4. **Check toast and status line appearance** in the desktop app and VS Code.
5. **The popup dialog** (`design/usage-popup/popup-standard.svg`, `popup-ultra.svg`; see that folder's README): a terminal dialog offering "Wait for reset" (default) or an override up to 100%. Standard plans see Session (5-hour) and Weekly rows with the session override available and the weekly one locked ("available on Ultra"); Ultra shows the Weekly row only, because Christian says Ultra has no 5-hour limit. Open questions before building it: what the mod API can draw in a terminal and whether it can take a keypress; and whether a mod can learn the user's plan at all (not checked; the Ultra rules assume it can). Until then the override is `/usage-guard block off`, or raise the cap.
6. Optional: a plugin icon (silences the validate warning); decide whether to keep or delete the untracked a/b design variants.

## 7. Conventions

- Commit trailer, ASCII `@`: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. (Task text has shown a fullwidth `@` several times; it is a typo, use the ASCII one.)
- The marketplace name equals the repo name (`claude-usage-guard`), one marketplace per repo, because usage-hud already owns `cj-mods` and two marketplaces with one name would likely clash. The plugin name stays `usage-guard`; the install id is `usage-guard@claude-usage-guard`.
- Sibling repos (`claude-audit-trail`, `claude-secret-guard`) are separate projects; never touch them from here.
- Never read or print `~/.claude/settings.json` or `~/.claude/.credentials.json`.
- Do not commit or push unless the user asks. Stage files by name, scan the staged diff for secrets first.
- Test kit gotchas: the test `$` has no `store` noun (tests answer `store.get/set/delete/keys` with their own Map-backed hooks); register every `on(...)` before the first `$` call; `mock.clock` gives an advanceable clock.
- README claims must stay honest about what the early-access API can and cannot do.

## 8. Resume prompt

Paste into a new chat:

> I'm Christian (GitHub luckyajinn, signs as CJ). We're continuing `claude-usage-guard`, a Claude Code mod that tracks the 5-hour and 7-day usage limits, warns once per threshold, and blocks new subagents near the cap through the `agent.spawn` hook. Clone https://github.com/luckyajinn/claude-usage-guard and read `HANDOFF.md` first, then `README.md`. State: `main` at `0d8d5e8`, pushed; 42 tests pass and `claude plugin validate .` passes, but it has never run in a live Claude Code session. Start by running `claude plugin validate .` and `claude plugin test .` to confirm the baseline, then do next step 1 in the HANDOFF (a live test using `/usage-guard warn 1` and `/usage-guard cap 1`) and tell me what you see. Don't commit or push unless I ask; trailer on commits is `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; never read my Claude settings or credentials files.
