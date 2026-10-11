# task-progress-mod

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) Mod that pins a
live progress bar above the prompt while the agent works through a
`TodoWrite` todo list — and, since v0.2, compresses the latest tool output
into a one-line summary under the bar. Zero dependencies, pure JS, no build
step.

When Claude Code grinds through a long task, the plan lives in the
transcript — you have to scroll up to find it, or interrupt the agent to ask
"where are you?". This mod watches `TodoWrite` tool calls and draws a
one-line summary that stays visible the whole time:

```
██████░░░░ 60% · step 3/5 · Writing tests…
⏷ Bash · 214 passed, 2 failed — tests/test_thing.py::test_edge_a FAILED
```

- **Percentage bar** — completed / total, 10-block resolution
- **step X/Y** — position of the current step in the full list
- **Current step** — the `activeForm` text of the `in_progress` todo
  (falls back to `content`, then to the first pending todo when nothing is
  in progress)
- **Tool-output summary (v0.2)** — the latest tool result, compressed to one
  line: failure lines + pass counts from test logs, JSON skeletons instead
  of payloads, diffs with lockfile churn collapsed, short outputs shown
  as-is. Labeled with the tool name so you can see what just ran.

The bar appears as soon as there is an active todo list (at least one
`in_progress` or `pending` todo) and disappears when the list is empty or
everything is completed. Every `TodoWrite` call and every tool result
re-renders it live.

## Install

Requires Claude Code v2.1.287+ (Mods support).

```bash
# Try it for one session:
/plugin install ./task-progress-mod
# or point Claude Code at the folder directly:
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ~/workspace/task-progress-mod
```

After installing, reload plugins (`/reload-plugins`) if a session is already
open. No MCP server, no daemon, no accounts, no network calls.

Plugin layout:

```
task-progress-mod/
  .claude-plugin/plugin.json   # name, version, description, author
  hooks/hooks.json             # -> ./register.js (single module)
  hooks/register.js            # the mod: tool.call + tool.result + ui.render hooks
  tests/test_mod.js            # node smoke tests (mocked events)
  README.md
  LICENSE
```

## What the user sees

Above the prompt, while a task is running:

```
████░░░░░░ 40% · step 3/5 · Writing tests
⏷ Bash · npm test: 41 passed
```

When the agent marks a todo completed and moves on, the bar updates on the
next render — no scrolling, no asking, no tokens spent on status checks.
When a tool finishes, its output is compressed into the second line: a
10,000-line test log becomes `214 passed, 2 failed — <first failure>`, a
lockfile-heavy diff becomes `diff: 1 file — src/index.js (+2/−1) · 1
lockfile hidden`, and a 300-item JSON response becomes
`{status: "ok", results: [...300 items], total: 300}`. When the last todo
completes, the whole thing hides itself.

## Usage

Nothing to configure for the basics — install the plugin and run a task that
uses `TodoWrite`. The summary line appears automatically after the first
tool result lands, and always reflects the most recent tool output.

Tuning constants live at the top of `hooks/register.js`:

- `BAR_WIDTH` (default `10`) — blocks in the bar
- `LABEL_MAX` (default `56`) — max chars of the current-step label
- `OUTPUT_LONG_THRESHOLD` (default `600`) — outputs longer than this (chars)
  get summarized; shorter ones are shown as-is on one line
- `OUTPUT_SUMMARY_MAX` (default `220`) — max chars of the rendered summary line
- `SUMMARY_DETAIL_MAX` (default `140`) — max chars of a single failure detail

No config file, no settings UI. Edit the constants and reload the plugin.

## Differentiation

- **In-task progress, not platform status.** A spinner that says "working…"
  tells you the platform is busy; it says nothing about *your* task. This
  mod shows the task's own state — which step of the plan you're on, what
  the current step is called, and what the last tool actually produced.
  The tool-call stream doubles as a deviation detector: if the agent
  drifts off-plan, the summary line shows it before the next todo update.
- **vs asking "where are you?"** — interrupting the agent to check progress
  costs a turn and pollutes context; the mid-task answer is often stale by
  the time you read it. The mod is ambient: it reads the same `TodoWrite`
  state the agent maintains and shows it without any model involvement.
- **vs scrolling the transcript** — `TodoWrite` updates are already in the
  transcript, but they scroll away during long tool runs. This pins the two
  lines you actually want (percent, step, current action, latest result)
  above the prompt where they never scroll off.
- **vs statusline hacks** — a custom statusline is static shell config that
  can't see tool-call payloads. This hooks the real `tool.call` /
  `tool.result` events, so it tracks the authoritative todo list (including
  `activeForm` phrasing that never appears in a statusline) and the real
  tool outputs.
- **vs context-compression tools** — tools that compress tool output for the
  *model* (to save context tokens) work invisibly in the pipeline. This mod
  compresses tool output for the *human*: the summary is drawn on screen,
  next to the progress bar, so you get the signal without reading the log.
  Same compression idea, opposite audience.
- **Mod form, not a sidecar.** No dashboard to open, no polling script, no
  MCP server. It lives inside the Claude Code session as a Mod and draws in
  the existing `AbovePrompt` band — zero setup beyond install.

## Honest limitations

- **Component choice is deliberate.** The spec sketch said `Pane`, but a
  `Pane` only draws at ≥144 terminal columns (110 once explicitly opened).
  The band above the prompt is `AbovePrompt`, which always draws — so the
  mod hooks `{ component: 'AbovePrompt' }`. Two short lines don't need a
  sidebar.
- **Event shapes are defensive, not pinned.** Public docs don't pin the
  exact `tool.call` payload for `TodoWrite` — or the `tool.result` payload
  at all — so the mod extracts the todo list and the tool output from every
  plausible location (`e.input.todos`, `e.output`, `e.result`, `e.data…`).
  If a future build moves something somewhere new, that part silently stops
  updating instead of crashing (fail-open).
- **The summarizer is heuristic, not a parser.** It looks for framework
  summary lines (`2 failed, 214 passed`), failure-ish lines, JSON shapes,
  and diff headers. Weird formats degrade to "first meaningful line" —
  never a crash, occasionally a bland summary.
- **Only the latest tool output is shown.** History lives in the transcript;
  the band is a glanceable "what just happened", not a log viewer.
- **State is module-level, not `$.state`.** A hot reload resets the snapshot
  and the bar hides until the next `TodoWrite` call re-captures it.
  Self-healing, but if you stare at the bar across a reload you'll see it
  blink out once.
- **Only TodoWrite is tracked.** Plans kept in prose, or tools other than
  `TodoWrite`, are invisible to the mod — by design; it shows the plan the
  agent committed to the todo list, nothing inferred.
- **Drawing surfaces vary.** The bar renders in the terminal and the
  Desktop Code tab. Hooks still *run* in VS Code, `claude -p`, and the
  Agent SDK, but nothing drawn appears there (engine behavior, not this
  mod's choice).
- **Not validated against the real engine here.** The mod follows the
  published Mods API shape (`register(on)`, `$.ui.resolve(e)`,
  `$.ui.invalidate('ui.render')`, `next(e)` passthrough) and passes
  mocked-event smoke tests, but `claude plugin validate` / `claude plugin
  test` were not run in this environment — run them before publishing.

## Development

```bash
node tests/test_mod.js   # 63 checks, mocked on/$/e/next, zero dependencies
```

The suite covers: bar math at 0%/40%/75%, step numbering, `activeForm`
vs `content` fallback, hiding when idle (empty / all-completed returns
`next(e)`), three `TodoWrite` event shapes, malformed-input fail-open,
`$.ui.invalidate` on capture, label truncation, a static scan of
`register.js` for loader-banned globals (`require`, `process`, `fetch`,
timers, JSX) — plus the v0.2 summarizer: long pytest logs (failure detail
+ pass counts), all-pass logs, short-output passthrough, JSON skeletons,
diff lockfile-noise filtering, failure truncation, render integration
(summary under the bar, latest-wins, tool-name labeling), malformed
`tool.result` fail-open, and invalidate on result capture.

## License

MIT
