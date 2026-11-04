# Usage popup (design mockup)

Static SVG mockups of the terminal dialog shown when a usage window nears its limit, with a way to override the safety stop and risk reaching 100%. They show intended behavior; the mod does not draw this dialog yet. Today `usage-guard` warns with a toast and refuses new subagents at the cap, and `/usage-guard` changes the thresholds.

| File | Plan | What it shows |
|---|---|---|
| [popup-standard.svg](popup-standard.svg) | Plans with a 5-hour limit | Session (5-hour) and Weekly (7-day) rows. The session override is available. The weekly override is locked: "Weekly override is available on Ultra." |
| [popup-ultra.svg](popup-ultra.svg) | Ultra | Weekly (7-day) row only, because Ultra has no 5-hour session limit. The weekly override is available. An "Ultra" label sits in the header. |

Rules the mockups follow:

- "Wait for reset" is the default and the first choice.
- Every override starts unticked. An override lets Claude use up to 100% of that window; at 100% it stops until the window resets, possibly mid-task.
- Meters show the percentage as text as well as cells, and the locked row shows a padlock and words, never color alone.
- Each file carries a light and a dark palette (`prefers-color-scheme`), and is a single self-contained SVG with no scripts or external references.
