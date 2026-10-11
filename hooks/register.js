// task-progress-mod — live TodoWrite progress bar above the prompt,
// now with tool-output summarization (v0.2).
//
// Hooks:
//   tool.call { tool: 'TodoWrite' }      -> capture the todo list, invalidate ui.render
//   tool.call (any)                      -> remember the tool name for labeling
//   tool.result (any)                    -> summarize the output, invalidate ui.render
//   ui.render { component: 'AbovePrompt' } -> draw the progress bar (+ summary line)
//
// Why summarize: long tool runs (test logs, build logs, diffs) dump tens of
// thousands of characters into the transcript — pages of PASSED lines. v0.2
// compresses the most recent tool output into one line and shows it under the
// bar, so the band reads as "progress + compressed":
//
//   ██████░░░░ 60% · step 3/5 · Writing tests…
//   ⏷ Bash · 214 passed, 2 failed — FAILED tests/test_thing.py::test_edge_a
//
// Pure JS, zero dependencies, no JSX: elements are called as plain functions
// (Box({...}), Text({...})), which the mod loader supports without a build step.
//
// Loader constraints honored (static scan): `$` appears only as
// `$.noun.method(...)` at call sites; event names are string literals;
// no require/fetch/Node globals.

'use strict';

var BAR_WIDTH = 10;
var FILLED = '█'; // U+2588 FULL BLOCK
var EMPTY = '░'; // U+2591 LIGHT SHADE
var LABEL_MAX = 56; // max chars of the current-step label before truncation

// ---- v0.2 tuning ----
var OUTPUT_LONG_THRESHOLD = 600; // outputs longer than this get summarized
var OUTPUT_SUMMARY_MAX = 220; // max chars of the rendered summary line
var SUMMARY_DETAIL_MAX = 140; // max chars of a single failure detail line
var SUMMARY_PREFIX = '⏷ '; // marker for the summary line under the bar

// Snapshot of the latest todo list from the most recent TodoWrite call.
// Module-level: a hot reload resets this to [] (bar hides), and the next
// TodoWrite call re-captures it. Self-healing, no persistence needed.
var latestTodos = [];

// Most recent tool-output summary ({ tool, text }), or null when nothing
// captured yet. Rendered under the bar while a todo list is active.
var latestSummary = null;

// Tool name of the most recent tool.call, so a tool.result event that does
// not name its tool can still be labeled.
var lastToolName = '';

function isTodoList(v) {
  return (
    Array.isArray(v) &&
    v.every(function (t) {
      return t !== null && typeof t === 'object';
    })
  );
}

// The exact tool.call event shape for TodoWrite input is not pinned down in
// public docs, so extract defensively from every plausible location.
function extractTodos(e) {
  if (!e || typeof e !== 'object') return null;
  var candidates = [
    e.input && e.input.todos,
    e.todos,
    e.params && e.params.todos,
    e.arguments && e.arguments.todos,
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (isTodoList(candidates[i])) return candidates[i];
  }
  return null;
}

// Tool name and output are extracted the same defensive way: the exact
// tool.result event shape is not pinned down in public docs.
function extractToolName(e) {
  if (!e || typeof e !== 'object') return '';
  var candidates = [e.tool, e.name, e.toolName];
  for (var i = 0; i < candidates.length; i++) {
    if (typeof candidates[i] === 'string' && candidates[i]) return candidates[i];
  }
  return '';
}

function extractOutput(e) {
  if (!e || typeof e !== 'object') return null;
  var candidates = [e.output, e.result, e.text];
  if (e.data && typeof e.data === 'object') {
    candidates.push(e.data.output, e.data.result, e.data.text);
  }
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (typeof c === 'string' && c.length > 0) return c;
    if (
      c !== null &&
      typeof c === 'object' &&
      typeof c.text === 'string' &&
      c.text.length > 0
    ) {
      return c.text;
    }
  }
  return null;
}

function todoStatus(t) {
  return typeof t.status === 'string' ? t.status : 'pending';
}

// Returns { pct, filled, step, total, label }, or null when there is nothing
// worth showing (no todos, all completed, or no active step found).
function progressView(todos) {
  var total = todos.length;
  if (total === 0) return null;
  var done = 0;
  var currentIdx = -1;
  for (var i = 0; i < total; i++) {
    var s = todoStatus(todos[i]);
    if (s === 'completed') {
      done++;
    } else if (currentIdx === -1 && (s === 'in_progress' || s === 'pending')) {
      currentIdx = i;
    }
  }
  if (done === total || currentIdx === -1) return null;
  var pct = Math.round((done / total) * 100);
  var current = todos[currentIdx];
  var label =
    (typeof current.activeForm === 'string' && current.activeForm) ||
    (typeof current.content === 'string' && current.content) ||
    '';
  if (label.length > LABEL_MAX) label = label.slice(0, LABEL_MAX - 1) + '…';
  return {
    pct: pct,
    filled: Math.round((done / total) * BAR_WIDTH),
    step: currentIdx + 1,
    total: total,
    label: label,
  };
}

function barString(filled) {
  var bar = '';
  for (var i = 0; i < BAR_WIDTH; i++) bar += i < filled ? FILLED : EMPTY;
  return bar;
}

// ---- v0.2: tool-output summarizer ----

function splitLines(t) {
  return String(t).split(/\r?\n/);
}

function oneLine(t) {
  return String(t)
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '');
}

function trunc(t, n) {
  t = String(t);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// A line counts as failure evidence, unless it explicitly reports zero.
// ("0 failed", "no failures" are good news, not failures.)
function isFailLine(line) {
  if (/\b0\s+(failed|failures|errors)\b/i.test(line)) return false;
  if (/\bno\s+(failures|errors)\b/i.test(line)) return false;
  return (
    /\b(fail|failed|failure|error|errors|exception|panic|traceback|assert)\b/i.test(
      line
    ) || /[✗✘×]/.test(line)
  );
}

// Look for framework summary counts, e.g. pytest "2 failed, 214 passed",
// jest "Tests: 2 failed, 214 passed, 216 total", vitest "3 failed | 187 passed".
function findSummaryCounts(lines) {
  var failed = 0;
  var passed = 0;
  var found = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var m =
      line.match(/(\d+)\s+failed\s*[,|]\s*(\d+)\s+passed/i) ||
      line.match(/tests:\s*(\d+)\s+failed\s*,\s*(\d+)\s+passed/i);
    if (m) return { failed: +m[1], passed: +m[2] };
    var mp = line.match(/(\d+)\s+(?:tests?\s+)?passed\b/i);
    if (mp && !/\b0\s+passed\b/i.test(line)) {
      passed = Math.max(passed, +mp[1]);
      found = true;
    }
    var mf = line.match(/(\d+)\s+(?:tests?\s+)?failed\b/i);
    if (mf && !/\b0\s+failed\b/i.test(line)) {
      failed = Math.max(failed, +mf[1]);
      found = true;
    }
  }
  return found ? { failed: failed, passed: passed } : null;
}

// The first concrete failure line (skipping the counts summary itself).
function firstFailDetail(lines) {
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    if (/(\d+)\s+failed\s*[,|]\s*(\d+)\s+passed/i.test(line)) continue;
    if (/tests:\s*\d+\s+failed/i.test(line)) continue;
    if (isFailLine(line)) return trunc(oneLine(line), SUMMARY_DETAIL_MAX);
  }
  return '';
}

function countPassLines(lines) {
  var n = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || /\b0\s+passed\b/i.test(line)) continue;
    if (/[✓✔]/.test(line) || /\b(passed|ok|success|successful)\b/i.test(line))
      n++;
  }
  return n;
}

// Test/build logs: failures first, then pass counts.
function summarizeLog(text) {
  var lines = splitLines(text);
  var counts = findSummaryCounts(lines);
  var detail = firstFailDetail(lines);
  if (counts) {
    var s = '';
    if (counts.passed) s += counts.passed + ' passed';
    if (counts.failed) s += (s ? ', ' : '') + counts.failed + ' failed';
    if (detail) s += ' — ' + detail;
    if (s) return s;
  }
  if (detail) return detail;
  var n = countPassLines(lines);
  if (n > 0) return n + ' passed';
  return '';
}

function tryJsonValue(text) {
  var t = text.trim();
  if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return undefined;
  try {
    return JSON.parse(t);
  } catch (err) {
    return undefined;
  }
}

// JSON output: show the skeleton, not the payload.
// {status: "ok", results: [...300 items], total: 300}
function jsonSkeleton(v, depth) {
  if (Array.isArray(v)) return '[...' + v.length + ' items]';
  if (v !== null && typeof v === 'object') {
    if (depth >= 1) return '{...}';
    var keys = Object.keys(v);
    if (keys.length === 0) return '{}';
    var shown = keys.slice(0, 8).map(function (k) {
      return k + ': ' + jsonSkeleton(v[k], depth + 1);
    });
    return '{' + shown.join(', ') + (keys.length > 8 ? ', …' : '') + '}';
  }
  if (typeof v === 'string') return JSON.stringify(trunc(v, 40));
  return String(v);
}

var LOCKFILE_RE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/;

function isDiffText(text) {
  return /(^|\n)diff --git |(^|\n)\+\+\+ b\//.test(text);
}

// Diffs: per-file +/- counts, lockfile churn collapsed to one note.
function summarizeDiff(text) {
  var lines = splitLines(text);
  var files = [];
  var cur = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    var mp = m ? null : line.match(/^\+\+\+ b\/(.+)$/);
    var path = m ? m[2] : mp ? mp[1] : null;
    if (path) {
      // A `+++ b/` line right after its `diff --git` line is the same file,
      // not a new one.
      if (!cur || cur.path !== path) {
        cur = { path: path, add: 0, del: 0 };
        files.push(cur);
      }
      continue;
    }
    if (cur) {
      if (/^\+(?!\+)/.test(line)) cur.add++;
      else if (/^-(?!-)/.test(line)) cur.del++;
    }
  }
  if (files.length === 0) return '';
  var lock = files.filter(function (f) {
    return LOCKFILE_RE.test(f.path);
  });
  var code = files.filter(function (f) {
    return !LOCKFILE_RE.test(f.path);
  });
  function totals(fs) {
    var a = 0;
    var d = 0;
    fs.forEach(function (f) {
      a += f.add;
      d += f.del;
    });
    return { a: a, d: d };
  }
  if (code.length === 0) {
    var t = totals(files);
    return (
      'diff: ' +
      files.length +
      ' lockfile-only file' +
      (files.length > 1 ? 's' : '') +
      ' changed (+' +
      t.a +
      '/−' +
      t.d +
      '), noise hidden'
    );
  }
  var parts = code.map(function (f) {
    return f.path + ' (+' + f.add + '/−' + f.del + ')';
  });
  var s =
    'diff: ' +
    code.length +
    ' file' +
    (code.length > 1 ? 's' : '') +
    ' — ' +
    parts.slice(0, 4).join(', ');
  if (parts.length > 4) s += ', …';
  if (lock.length)
    s += ' · ' + lock.length + ' lockfile' + (lock.length > 1 ? 's' : '') + ' hidden';
  return s;
}

// Compress one tool output into a single summary line.
// Returns { tool, text }, or null for empty input.
export function summarizeOutput(tool, text) {
  var t = typeof text === 'string' ? text : String(text == null ? '' : text);
  var toolName = typeof tool === 'string' && tool ? tool : '';
  if (!t.trim()) return null;
  // Short outputs: show as-is, collapsed to one line.
  if (t.length <= OUTPUT_LONG_THRESHOLD) {
    return { tool: toolName, text: trunc(oneLine(t), OUTPUT_SUMMARY_MAX) };
  }
  var s = '';
  if (isDiffText(t)) {
    s = summarizeDiff(t) || summarizeLog(t);
  } else {
    var j = tryJsonValue(t);
    s = j === undefined ? summarizeLog(t) : jsonSkeleton(j, 0);
  }
  if (!s) {
    var first = splitLines(t).filter(function (l) {
      return l.trim();
    })[0];
    s = trunc(oneLine(first || ''), OUTPUT_SUMMARY_MAX);
  }
  return { tool: toolName, text: trunc(oneLine(s), OUTPUT_SUMMARY_MAX) };
}

// Test seam: reset module state between smoke-test scenarios.
// The mod loader ignores this export.
export function __resetModState() {
  latestTodos = [];
  latestSummary = null;
  lastToolName = '';
}

export function register(on) {
  // Observe TodoWrite calls: snapshot the list and ask the engine to re-render.
  on('tool.call', { tool: 'TodoWrite' }, async function ($, e, next) {
    var t = extractTodos(e);
    if (t) {
      latestTodos = t;
      $.ui.invalidate('ui.render');
    }
    return next(e);
  });

  // Remember the tool name of every tool call, so a tool.result event that
  // does not name its own tool can still be labeled in the summary line.
  on('tool.call', async function ($, e, next) {
    var n = extractToolName(e);
    if (n) lastToolName = n;
    return next(e);
  });

  // Observe tool results: summarize the output, then re-render.
  // Malformed events (no output) are fail-open: nothing changes, next runs.
  on('tool.result', async function ($, e, next) {
    var out = extractOutput(e);
    if (out) {
      var s = summarizeOutput(extractToolName(e) || lastToolName, out);
      if (s) {
        latestSummary = s;
        $.ui.invalidate('ui.render');
      }
    }
    return next(e);
  });

  // Band above the prompt. Return next(e) (draw nothing) when idle.
  on('ui.render', { component: 'AbovePrompt' }, async function ($, e, next) {
    var v = progressView(latestTodos);
    if (!v) return next(e);
    // await works whether resolve() is sync or async in this build.
    var resolved = await $.ui.resolve(e);
    var Box = resolved.Box;
    var Text = resolved.Text;
    var suffix =
      ' ' +
      v.pct +
      '% · step ' +
      v.step +
      '/' +
      v.total +
      (v.label ? ' · ' + v.label : '');
    var barLine = Box({
      flexDirection: 'row',
      children: [
        Text({ color: 'green', children: barString(v.filled) }),
        Text({ dimColor: true, children: suffix }),
      ],
    });
    if (latestSummary && latestSummary.text) {
      return Box({
        flexDirection: 'column',
        children: [
          barLine,
          Text({
            dimColor: true,
            children:
              SUMMARY_PREFIX +
              (latestSummary.tool ? latestSummary.tool + ' · ' : '') +
              latestSummary.text,
          }),
        ],
      });
    }
    return barLine;
  });
}
