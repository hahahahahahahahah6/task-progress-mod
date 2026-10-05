# task-progress-mod

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) Mod that pins a
live progress bar above the prompt while the agent works through a
`TodoWrite` todo list. Zero dependencies, pure JS, no build step.

When Claude Code grinds through a long task, the plan lives in the
transcript — you have to scroll up to find it, or interrupt the agent to ask
"where are you?". This mod watches `TodoWrite` tool calls and draws a
one-line summary that stays visible the whole time:

```
██████░░░░ 60% · step 3/5 · Writing tests…
```

- **Percentage bar** — completed / total, 10-block resolution
- **step X/Y** — position of the current step in the full list
- **Current step** — the `activeForm` text of the `in_progress` todo
  (falls back to `content`, then to the first pending todo when nothing is
  in progress)

The bar appears as soon as there is an active todo list (at least one
`in_progress` or `pending` todo) and disappears when the list is empty or
everything is completed. Every `TodoWrite` call re-renders it live.

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
  hooks/register.js            # the mod: tool.call + ui.render hooks
  tests/test_mod.js            # node smoke tests (mocked events)
  README.md
  LICENSE
```

## What the user sees

Above the prompt, while a task is running:

```
████░░░░░░ 40% · step 3/5 · Writing tests
```

When the agent marks a todo completed and moves on, the bar updates on the
next render — no scrolling, no asking, no tokens spent on status checks.
When the last todo completes, the bar hides itself.

## Differentiation

- **vs asking "where are you?"** — interrupting the agent to check progress
  costs a turn and pollutes context; the mid-task answer is often stale by
  the time you read it. The mod is ambient: it reads the same `TodoWrite`
  state the agent maintains and shows it without any model involvement.
- **vs scrolling the transcript** — `TodoWrite` updates are already in the
  transcript, but they scroll away during long tool runs. This pins the one
  line you actually want (percent, step, current action) above the prompt
  where it never scrolls off.
- **vs statusline hacks** — a custom statusline is static shell config that
  can't see tool-call payloads. This hooks the real `tool.call` event, so it
  tracks the authoritative todo list, including `activeForm` phrasing that
  never appears in a statusline.

## Configuration

Tuning constants live at the top of `hooks/register.js`:

- `BAR_WIDTH` (default `10`) — blocks in the bar
- `LABEL_MAX` (default `56`) — max chars of the current-step label

No config file, no settings UI. Edit the two constants and reload the
plugin.

## Honest limitations

- **Component choice is deliberate.** The spec sketch said `Pane`, but a
  `Pane` only draws at ≥144 terminal columns (110 once explicitly opened).
  The band above the prompt is `AbovePrompt`, which always draws — so the
  mod hooks `{ component: 'AbovePrompt' }`. A one-line bar doesn't need a
  sidebar.
- **TodoWrite event shape is defensive, not pinned.** Public docs don't pin
  the exact `tool.call` payload for `TodoWrite`, so the mod extracts the
  list from `e.input.todos`, `e.todos`, `e.params.todos`, and
  `e.arguments.todos`. If a future build moves it somewhere new, the bar
  silently stops updating instead of crashing (fail-open).
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
node tests/test_mod.js   # 33 checks, mocked on/$/e/next, zero dependencies
```

The suite covers: bar math at 0%/40%/75%, step numbering, `activeForm`
vs `content` fallback, hiding when idle (empty / all-completed returns
`next(e)`), three `TodoWrite` event shapes, malformed-input fail-open,
`$.ui.invalidate` on capture, label truncation, and a static scan of
`register.js` for loader-banned globals (`require`, `process`, `fetch`,
timers, JSX).

## License

MIT
