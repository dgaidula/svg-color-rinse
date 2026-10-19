import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI = new URL('../svg-color-rinse.mjs', import.meta.url).pathname;
const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

const run = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8' });

test('neutral gate: dry-run report on grayscale fixture', () => {
  const out = run('--dry-run', path.join(FIXTURES, 'grays.svg'));
  // every near-black form is caught: class, gradient stop, rgb(), inline style
  assert.match(out, /#171617 .*-> #000000/);
  assert.match(out, /#242228 .*-> #000000/);
  assert.match(out, /rgb\(23, 22, 23\) .*-> #000000/);
  assert.match(out, /#101011 .*-> #000000/);
  // near-whites wash to white
  assert.match(out, /#eae9eb .*-> #ffffff/);
  assert.match(out, /#fdfcfd .*-> #ffffff/);
  // 79.6% gray, mid gray, saturated red, and existing anchors are untouched
  assert.doesNotMatch(out, /#343435/);
  assert.doesNotMatch(out, /#88888b/);
  assert.doesNotMatch(out, /#8b0000/);
});

test('neutral gate: written file has a clean palette', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rinse-'));
  try {
    const file = path.join(dir, 'grays.svg');
    copyFileSync(path.join(FIXTURES, 'grays.svg'), file);
    run(file);
    const rinsed = readFileSync(path.join(dir, 'grays-rinsed.svg'), 'utf8');
    const colors = new Set(rinsed.match(/#[0-9a-fA-F]{3,6}|rgb\(\s*\d[^)]*\)/g));
    assert.deepEqual(
      [...colors].sort(),
      ['#000', '#000000', '#343435', '#88888b', '#8b0000', '#fff', '#ffffff'].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hue gate: heavy blues merge to darkest claimed blue', () => {
  const out = run('--dry-run', '--hue', 'blue', path.join(FIXTURES, 'blues.svg'));
  assert.match(out, /neutral .*#0a1123 .*-> #000000/);   // murky near-black is neutral's
  assert.match(out, /hue .*#172951 .*-> #101c37/);       // merges to the anchor
  assert.match(out, /neutral .*#e8eefa .*-> #ffffff/);   // pale wash
  assert.doesNotMatch(out, /#476eca/);                   // mid blue untouched
  assert.doesNotMatch(out, /#101c37 .*->/);              // the anchor itself never remaps
});

test('hue gate: explicit --dark pins the anchor', () => {
  const out = run('--dry-run', '--hue', '220', '--dark', '#0a1123',
    path.join(FIXTURES, 'blues.svg'));
  assert.match(out, /#101c37 .*-> #0a1123/);
  assert.match(out, /#172951 .*-> #0a1123/);
});

test('--optimize runs svgo after rinsing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rinse-'));
  try {
    const file = path.join(dir, 'grays.svg');
    copyFileSync(path.join(FIXTURES, 'grays.svg'), file);
    const out = run('--optimize', file);
    assert.match(out, /optimized [\d,]+ -> [\d,]+ bytes/);
    const rinsed = readFileSync(path.join(dir, 'grays-rinsed.svg'), 'utf8');
    assert.ok(rinsed.startsWith('<svg'));
    assert.ok(rinsed.length < readFileSync(file, 'utf8').length);
    assert.doesNotMatch(rinsed, /#171617/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--quantize collapses jittered mid-grays onto N levels', () => {
  const out = run('--dry-run', '--quantize', '3', path.join(FIXTURES, 'mids.svg'));
  assert.match(out, /quantize .*#bec0bd .*-> #bfbfbf/);
  assert.match(out, /quantize .*#c1bfc0 .*-> #bfbfbf/);
  assert.match(out, /quantize .*#80827f .*-> #808080/);
  assert.match(out, /quantize .*#7e8180 .*-> #808080/);
  assert.match(out, /quantize .*#3e413f .*-> #404040/);
  assert.match(out, /quantize .*#423f41 .*-> #404040/);
  // exactly on a level already: no self-replacement row
  assert.doesNotMatch(out, /#808080 .*-> #808080/);
  // saturated color: quantize never touches it
  assert.doesNotMatch(out, /#8b5a3c/);
  // heavy near-black is the neutral gate's, not quantize's
  assert.match(out, /neutral .*#141213 .*-> #000000/);
  assert.doesNotMatch(out, /quantize .*#141213/);
});

test('--quantize written file collapses to exactly N distinct grays', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rinse-'));
  try {
    const file = path.join(dir, 'mids.svg');
    copyFileSync(path.join(FIXTURES, 'mids.svg'), file);
    run('--quantize', '3', file);
    const rinsed = readFileSync(path.join(dir, 'mids-rinsed.svg'), 'utf8');
    const colors = new Set(rinsed.match(/#[0-9a-fA-F]{3,6}/g));
    assert.deepEqual(
      [...colors].sort(),
      ['#000000', '#404040', '#808080', '#8b5a3c', '#bfbfbf'].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--quantize does not double-process gate-claimed colors', () => {
  const out = run('--dry-run', '--hue', 'blue', '--quantize', '3', path.join(FIXTURES, 'blues.svg'));
  // hue gate still merges the heavy blue to its anchor, untouched by quantize
  assert.match(out, /hue .*#172951 .*-> #101c37/);
  // the mid blue is saturated -- quantize's neutral-only scope leaves it alone
  assert.doesNotMatch(out, /#476eca/);
  assert.doesNotMatch(out, /quantize/);
});

test('--quantize rejects non-integer or sub-1 N', () => {
  const fixture = path.join(FIXTURES, 'mids.svg');
  for (const bad of ['0', '--quantize=-1', '2.5', 'abc']) {
    const args = bad.startsWith('--quantize=') ? [bad, fixture] : ['--quantize', bad, fixture];
    assert.throws(() => run(...args), /--quantize must be an integer >= 1/);
  }
});

test('folder mode recurses and skips *-rinsed.svg outputs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rinse-'));
  try {
    copyFileSync(path.join(FIXTURES, 'grays.svg'), path.join(dir, 'grays.svg'));
    copyFileSync(path.join(FIXTURES, 'blues.svg'), path.join(dir, 'blues.svg'));
    run(dir);
    const second = run(dir); // outputs from run 1 must not be picked up as inputs
    assert.doesNotMatch(second, /^grays-rinsed\.svg:/m);
    assert.doesNotMatch(second, /^blues-rinsed\.svg:/m);
    assert.match(second, /^grays\.svg:/m);
    assert.match(second, /^blues\.svg:/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- --cheat card ----------------------------------------------------------------

// Parse a --cheat card as a tldr page, throwing a message that names the first
// rule it breaks. The shape is the one the CHEAT comment in the tool spells out:
// "# name", blank, "> " lines ending "> More information: name --help.", blank,
// then 3 to 6 examples of "- what it does:", blank, "`name args`", blank-separated.
// Copy this into an adopted tool's tests to prove its card is a page.
function parseCheat(text) {
  const fail = (m) => { throw new Error(`cheat card: ${m}`); };
  if (!text.endsWith('\n') || text.endsWith('\n\n')) fail('must end with exactly one newline');
  const lines = text.slice(0, -1).split('\n');
  const title = /^# (\S+)$/.exec(lines[0]);
  if (!title) fail('line 1 must be "# <tool-name>"');
  const name = title[1];
  if (lines[1] !== '') fail('line 2 must be blank');
  let i = 2;
  const description = [];
  while (i < lines.length && lines[i].startsWith('> ')) description.push(lines[i++].slice(2));
  if (description.length < 2) fail('the description block needs a purpose line and a "More information" line');
  if (description.at(-1) !== `More information: ${name} --help.`) fail('the description block must end "More information: <tool-name> --help."');
  const examples = [];
  while (i < lines.length) {
    if (lines[i] !== '') fail(`line ${i + 1} must be blank before an example`);
    const [what, gap, cmd] = lines.slice(i + 1, i + 4);
    if (!/^- [A-Z].*:$/.test(what ?? '')) fail(`line ${i + 2} must be "- Sentence-case description:"`);
    if (gap !== '') fail(`line ${i + 3} must be blank between the description and the command`);
    const m = /^`([\x20-\x7e]+)`$/.exec(cmd ?? '');
    if (!m) fail(`line ${i + 4} must be the command in backticks, in plain ASCII`);
    if (m[1] !== name && !m[1].startsWith(`${name} `)) fail(`line ${i + 4} must start with the tool name "${name}"`);
    if ((m[1].match(/\{\{/g) ?? []).length !== (m[1].match(/\}\}/g) ?? []).length) fail(`line ${i + 4} has unbalanced {{placeholders}}`);
    examples.push({ what: what.slice(2), cmd: m[1] });
    i += 4;
  }
  if (examples.length < 3 || examples.length > 6) fail(`needs 3 to 6 examples, has ${examples.length}`);
  return { name, description, examples };
}

test('--cheat prints a tldr page titled with the command name, exits 0, and prints nothing else', () => {
  const r = spawnSync('node', [CLI, '--cheat'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const page = parseCheat(r.stdout);
  assert.equal(page.name, 'svg-color-rinse');
  assert.ok(page.examples.length >= 3);
});

test('--help wins over --cheat in either order', () => {
  const help = spawnSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  for (const args of [['--help', '--cheat'], ['--cheat', '--help']]) {
    const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, args.join(' '));
    assert.equal(r.stdout, help.stdout, args.join(' '));
  }
});
