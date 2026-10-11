// Smoke tests for task-progress-mod. Pure node, zero dependencies.
// Mocks the mod loader surface: on(), $, e, next — no Claude Code needed.
//
//   node tests/test_mod.js        # or: npm test

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { register, summarizeOutput, __resetModState } from '../hooks/register.js';

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

function resultHandler() {
  const h = (handlers['tool.result'] || [])[0];
  if (!h) throw new Error('no tool.result handler registered');
  return h.handler;
}
function genericCallHandler() {
  const h = (handlers['tool.call'] || []).find((x) => x.matcher === undefined);
  if (!h) throw new Error('no matcher-less tool.call handler registered');
  return h.handler;
}

// Feed a TodoWrite event, optionally a tool.result event, then render.
async function runWithOutput(todos, toolResultEvent) {
  __resetModState();
  const { $, calls } = makeDollar();
  const next = async (e) => ({ __next: true, e });
  await toolCallHandler()($, { tool: 'TodoWrite', input: { todos } }, next);
  if (toolResultEvent !== null) await resultHandler()($, toolResultEvent, next);
  const { $: $2 } = makeDollar();
  const tree = await renderHandler()($2, { component: 'AbovePrompt' }, next);
  return { text: textOf(tree), calls, passthrough: tree && tree.__next === true };
}

// ---- v0.2 fixtures: long, noisy tool outputs ----

function pytestLog() {
  const lines = [];
  for (let i = 0; i < 214; i++)
    lines.push('tests/test_thing.py::test_case_' + i + ' PASSED');
  lines.push('tests/test_thing.py::test_edge_a FAILED');
  lines.push('tests/test_thing.py::test_edge_b FAILED');
  lines.push('');
  lines.push(
    '=========================== short test summary info ============================'
  );
  lines.push('FAILED tests/test_thing.py::test_edge_a - assert 1 == 2');
  lines.push('FAILED tests/test_thing.py::test_edge_b - assert 3 == 4');
  lines.push('2 failed, 214 passed in 12.34s');
  return lines.join('\n');
}

function jestLog() {
  const lines = ['PASS src/a.test.js', 'PASS src/b.test.js'];
  for (let i = 0; i < 39; i++) lines.push('  ✓ case ' + i + ' (5 ms)');
  lines.push('Test Suites: 2 passed, 2 total');
  lines.push('Tests:       41 passed, 41 total');
  lines.push('Snapshots:   0 written, 12 passed, 12 total');
  lines.push('Time:        3.21 s');
  return lines.join('\n');
}

function diffLog() {
  const lines = [
    'diff --git a/package-lock.json b/package-lock.json',
    'index abc123..def456 100644',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
  ];
  for (let i = 0; i < 300; i++) {
    lines.push('-    "old-dep-' + i + '": "1.0.0",');
    lines.push('+    "new-dep-' + i + '": "2.0.0",');
  }
  lines.push(
    'diff --git a/src/index.js b/src/index.js',
    '--- a/src/index.js',
    '+++ b/src/index.js',
    '@@ -1,3 +1,4 @@',
    '-const a = 1;',
    '+const a = 2;',
    '+const b = 3;'
  );
  return lines.join('\n');
}

console.log('v0.2 registration');
ok(typeof summarizeOutput === 'function', 'summarizeOutput is exported');
ok(typeof __resetModState === 'function', '__resetModState test seam is exported');
ok((handlers['tool.result'] || []).length > 0, 'hooks tool.result');
ok(
  (handlers['tool.call'] || []).some((x) => x.matcher === undefined),
  'hooks tool.call without matcher (tool-name recorder)'
);

console.log('summarize: long pytest log');
{
  const s = summarizeOutput('Bash', pytestLog());
  ok(
    s && s.text.includes('214 passed') && s.text.includes('2 failed'),
    'counts 214 passed, 2 failed (got: ' + (s && s.text) + ')'
  );
  ok(
    s && s.text.includes('tests/test_thing.py::test_edge_a FAILED'),
    'first failure line included'
  );
  ok(s && s.text.length <= 220, 'summary within 220 chars');
}

console.log('summarize: all-pass log');
{
  const s = summarizeOutput('Bash', jestLog());
  ok(s && s.text.includes('41 passed'), 'counts 41 passed (got: ' + (s && s.text) + ')');
  ok(s && !/failed/i.test(s.text), 'no failure mention when all pass');
}

console.log('summarize: short output passes through');
{
  const s = summarizeOutput('Bash', 'done\nall good');
  ok(s && s.text === 'done all good', 'short output shown as-is, one line');
}

console.log('summarize: JSON skeleton');
{
  const big = JSON.stringify({
    status: 'ok',
    results: Array.from({ length: 300 }, (_, i) => ({ id: i })),
    total: 300,
  });
  ok(big.length > 600, 'fixture is long enough to trigger summarization');
  const s = summarizeOutput('WebFetch', big);
  ok(
    s && s.text.includes('[...300 items]'),
    'arrays collapse to item counts (got: ' + (s && s.text) + ')'
  );
  ok(s && s.text.includes('status'), 'top-level keys preserved');
}

console.log('summarize: diff lockfile noise');
{
  const s = summarizeOutput('Bash', diffLog());
  ok(s && s.text.includes('src/index.js'), 'non-lockfile file listed');
  ok(
    s && /lockfile/.test(s.text) && /hidden/.test(s.text),
    'lockfile churn collapsed (got: ' + (s && s.text) + ')'
  );
  ok(s && !s.text.includes('old-dep-150'), 'raw lockfile lines not leaked');
}

console.log('summarize: failure detail truncation');
{
  const s = summarizeOutput('Bash', 'FAILED ' + 'x'.repeat(5000));
  ok(s && s.text.includes('…'), 'long failure detail truncated with ellipsis');
  ok(s && s.text.length <= 220, 'truncated summary within 220 chars');
}

console.log('render integration: summary under bar');
{
  const todos = [T('Write tests', 'in_progress', 'Writing tests'), T('Ship', 'pending')];
  const { text } = await runWithOutput(todos, { tool: 'Bash', output: pytestLog() });
  ok(text.includes('░░░░░░░░░░'), 'bar still drawn');
  ok(text.includes('⏷'), 'summary marker drawn under the bar');
  ok(text.includes('214 passed'), 'summary text rendered (got: ' + text + ')');
  ok(text.includes('Bash'), 'tool name labels the summary');
}

console.log('render integration: no summary, bar only');
{
  const todos = [T('Write tests', 'in_progress', 'Writing tests')];
  const { text } = await runWithOutput(todos, null);
  ok(text.includes('Writing tests'), 'bar drawn');
  ok(!text.includes('⏷'), 'no summary marker without tool output');
}

console.log('render integration: latest summary wins');
{
  const todos = [T('Write tests', 'in_progress')];
  __resetModState();
  const { $ } = makeDollar();
  const next = async (e) => ({ __next: true, e });
  await toolCallHandler()($, { tool: 'TodoWrite', input: { todos } }, next);
  await resultHandler()($, { tool: 'Bash', output: 'first output' }, next);
  await resultHandler()($, { tool: 'Bash', output: 'second output' }, next);
  const { $: $2 } = makeDollar();
  const text = textOf(await renderHandler()($2, { component: 'AbovePrompt' }, next));
  ok(
    text.includes('second output') && !text.includes('first output'),
    'most recent tool output wins'
  );
}

console.log('render integration: tool name from tool.call when result is unnamed');
{
  const todos = [T('Write tests', 'in_progress')];
  __resetModState();
  const { $ } = makeDollar();
  const next = async (e) => ({ __next: true, e });
  await toolCallHandler()($, { tool: 'TodoWrite', input: { todos } }, next);
  await genericCallHandler()($, { tool: 'Bash', input: { command: 'npm test' } }, next);
  await resultHandler()($, { output: 'all green' }, next); // no tool field
  const { $: $2 } = makeDollar();
  const text = textOf(await renderHandler()($2, { component: 'AbovePrompt' }, next));
  ok(text.includes('Bash'), 'summary labeled with tool name from tool.call');
}

console.log('malformed tool.result is fail-open');
{
  __resetModState();
  const { $, calls } = makeDollar();
  const next = async (e) => ({ __next: true });
  const res = await resultHandler()($, { tool: 'Bash' }, next); // no output field
  ok(res.__next === true, 'malformed tool.result still calls next(e)');
  ok(calls.invalidate.length === 0, 'no invalidate without output');
  ok(summarizeOutput('Bash', '') === null, 'empty output summarizes to null');
}

console.log('invalidate on tool.result capture');
{
  const todos = [T('A', 'pending')];
  const { calls } = await runWithOutput(todos, { tool: 'Bash', output: 'hello' });
  ok(calls.invalidate.includes('ui.render'), "tool.result capture calls $.ui.invalidate('ui.render')");
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
