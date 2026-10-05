// Smoke tests for task-progress-mod. Pure node, zero dependencies.
// Mocks the mod loader surface: on(), $, e, next — no Claude Code needed.
//
//   node tests/test_mod.js        # or: npm test

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { register } from '../hooks/register.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) {
    passed++;
    console.log('  ok - ' + name);
  } else {
    failed++;
    console.log('  FAIL - ' + name);
  }
}

// ---- mock element constructors: return plain descriptors so tests can
// ---- assert on the drawn tree without a real terminal surface.
function mockElements() {
  const Box = (props) => ({ __el: 'Box', props: props || {} });
  const Text = (props) => ({ __el: 'Text', props: props || {} });
  return { Box, Text };
}

// Recursively concatenate every Text child's string content.
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') {
    if (node.__el === 'Text') return textOf(node.props && node.props.children);
    if (node.props && 'children' in node.props) return textOf(node.props.children);
  }
  return '';
}

// Register once, capture handlers by event name.
const handlers = {};
function on(event, matcher, handler) {
  if (typeof matcher === 'function') {
    handler = matcher;
    matcher = undefined;
  }
  handlers[event] = handlers[event] || [];
  handlers[event].push({ matcher, handler });
}
register(on);

function toolCallHandler() {
  const h = (handlers['tool.call'] || []).find(
    (x) => x.matcher && x.matcher.tool === 'TodoWrite'
  );
  if (!h) throw new Error('no tool.call handler for TodoWrite registered');
  return h.handler;
}
function renderHandler() {
  const h = (handlers['ui.render'] || []).find(
    (x) => x.matcher && x.matcher.component === 'AbovePrompt'
  );
  if (!h) throw new Error('no ui.render handler for AbovePrompt registered');
  return h.handler;
}

function makeDollar() {
  const calls = { invalidate: [], log: [] };
  const { Box, Text } = mockElements();
  return {
    calls,
    $: {
      ui: {
        invalidate: (t) => calls.invalidate.push(t),
        resolve: (_e) => ({ Box, Text }), // sync resolve; mod awaits it
        log: (m) => calls.log.push(m),
      },
    },
  };
}

// Feed a TodoWrite event through the hook, then render and return drawn text.
async function runScenario(todos, eventShape) {
  const { $, calls } = makeDollar();
  const next = async (e) => ({ __next: true, e });
  const toolEvent =
    eventShape === 'bare'
      ? { tool: 'TodoWrite', todos }
      : eventShape === 'params'
        ? { tool: 'TodoWrite', params: { todos } }
        : { tool: 'TodoWrite', input: { todos } }; // default shape
  await toolCallHandler()($, toolEvent, next);
  const { $: $2 } = makeDollar();
  const tree = await renderHandler()($2, { component: 'AbovePrompt' }, next);
  return { text: textOf(tree), tree, calls, passthrough: tree && tree.__next === true };
}

function T(content, status, activeForm) {
  const t = { content, status };
  if (activeForm !== undefined) t.activeForm = activeForm;
  return t;
}

console.log('registration');
ok(typeof register === 'function', 'register is exported');
ok(
  (handlers['tool.call'] || []).some((x) => x.matcher && x.matcher.tool === 'TodoWrite'),
  "hooks tool.call with { tool: 'TodoWrite' }"
);
ok(
  (handlers['ui.render'] || []).some(
    (x) => x.matcher && x.matcher.component === 'AbovePrompt'
  ),
  "hooks ui.render with { component: 'AbovePrompt' }"
);

console.log('progress rendering');
{
  const todos = [
    T('Set up repo', 'completed'),
    T('Write parser', 'completed'),
    T('Write tests', 'in_progress', 'Writing tests'),
    T('Update docs', 'pending'),
    T('Release', 'pending'),
  ];
  const { text } = await runScenario(todos);
  ok(text.includes('████░░░░░░'), 'bar shows 4/10 blocks at 40% (got: ' + text + ')');
  ok(text.includes('40%'), 'shows 40%');
  ok(text.includes('step 3/5'), 'shows step 3/5');
  ok(text.includes('Writing tests'), 'shows activeForm of in_progress todo');
}

console.log('activeForm fallback to content');
{
  const todos = [T('First thing', 'pending'), T('Second thing', 'pending')];
  const { text } = await runScenario(todos);
  ok(text.includes('░░░░░░░░░░'), 'bar empty at 0%');
  ok(text.includes('0%'), 'shows 0%');
  ok(text.includes('step 1/2'), 'no in_progress -> first pending is step 1/2');
  ok(text.includes('First thing'), 'falls back to content when activeForm missing');
}

console.log('hiding when idle');
{
  // all completed -> next(e) passthrough, nothing drawn
  const done = [T('A', 'completed'), T('B', 'completed')];
  const r1 = await runScenario(done);
  ok(r1.passthrough === true, 'all completed -> returns next(e), draws nothing');
  ok(r1.text === '', 'no text drawn when all completed');

  // empty list -> hidden
  const r2 = await runScenario([]);
  ok(r2.passthrough === true, 'empty todo list -> returns next(e)');
}

console.log('event shape tolerance');
{
  const todos = [T('A', 'completed'), T('B', 'in_progress', 'Doing B')];
  for (const shape of ['bare', 'params', 'input']) {
    const { text } = await runScenario(todos, shape);
    ok(text.includes('50%') && text.includes('Doing B'), 'shape e.' + shape + ' captured');
  }
}

console.log('malformed input is fail-open');
{
  const { $, calls } = makeDollar();
  const next = async (e) => ({ __next: true });
  // no todos anywhere: state must not change, no crash, next still called
  const res = await toolCallHandler()($, { tool: 'TodoWrite', input: {} }, next);
  ok(res.__next === true, 'malformed event still calls next(e)');
  ok(calls.invalidate.length === 0, 'no invalidate on malformed event');
}

console.log('invalidate on capture');
{
  const { calls } = await runScenario([T('A', 'pending')]);
  ok(calls.invalidate.includes('ui.render'), "calls $.ui.invalidate('ui.render')");
}

console.log('label truncation');
{
  const long = 'x'.repeat(200);
  const { text } = await runScenario([T(long, 'in_progress', long)]);
  ok(text.includes('…'), 'long label truncated with ellipsis');
  ok(!text.includes(long), 'full 200-char label not rendered');
}

console.log('100% boundary');
{
  // 3/4 done, last one in progress -> 75%
  const todos = [
    T('a', 'completed'),
    T('b', 'completed'),
    T('c', 'completed'),
    T('d', 'in_progress', 'Finishing'),
  ];
  const { text } = await runScenario(todos);
  ok(text.includes('75%') && text.includes('step 4/4'), '75%, step 4/4 (got: ' + text + ')');
}

console.log('loader hygiene (static scan)');
{
  const src = readFileSync(join(ROOT, 'hooks', 'register.js'), 'utf8');
  const banned = [
    'require(',
    'process.',
    'console.',
    'fetch(',
    'setTimeout',
    'setInterval',
    '__dirname',
    'module.exports',
  ];
  for (const b of banned) {
    ok(!src.includes(b), 'source contains no ' + JSON.stringify(b));
  }
  ok(src.includes("export function register"), 'exports register as ESM');
  ok(!src.includes('<') || !src.match(/<[A-Z][a-zA-Z]*\s/), 'no JSX in source');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
