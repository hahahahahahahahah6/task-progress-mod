// task-progress-mod — live TodoWrite progress bar above the prompt.
//
// Hooks:
//   tool.call { tool: 'TodoWrite' }      -> capture the todo list, invalidate ui.render
//   ui.render { component: 'AbovePrompt' } -> draw (or hide) the progress bar
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

// Snapshot of the latest todo list from the most recent TodoWrite call.
// Module-level: a hot reload resets this to [] (bar hides), and the next
// TodoWrite call re-captures it. Self-healing, no persistence needed.
var latestTodos = [];

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
    return Box({
      flexDirection: 'row',
      children: [
        Text({ color: 'green', children: barString(v.filled) }),
        Text({ dimColor: true, children: suffix }),
      ],
    });
  });
}
