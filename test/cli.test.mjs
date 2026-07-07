import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
