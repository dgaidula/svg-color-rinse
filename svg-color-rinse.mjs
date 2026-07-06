#!/usr/bin/env node
// svg-color-rinse: normalize near-black and near-white colors in SVG exports.
//
// Recraft (and similar) exports scatter dozens of near-blacks and near-whites
// across an illustration. This tool snaps them to clean anchors:
//
//   - near-neutral colors at/above the black threshold (default 80% tint)
//     become true black #000000
//   - near-neutral colors at/below the white threshold (default 10% tint)
//     become true white #ffffff
//   - everything in between is left alone
//
// Tint is 1 - luma/255 (Rec.601). Only near-neutral colors are touched by
// default: anything with saturation above --max-saturation stays as-is, so a
// dark navy or deep red never collapses into black.
//
// Hue gates extend the same treatment to a color family. `--hue blue` (or a
// degree, e.g. --hue 220) claims colors within --tolerance degrees of that
// hue: heavy tints merge into one dark anchor (--dark, or by default the
// darkest matching color already in the file) and pale tints wash to white.
//
// Colors are rewritten wherever they appear: <style> blocks, fill/stroke/
// stop-color attributes, inline style="", in #rgb, #rrggbb, and rgb() forms.
//
// --optimize additionally runs svgo (preset-default, multipass, viewBox
// preserved) on each file after rinsing. Requires svgo to be installed;
// without --optimize the tool has zero dependencies.
//
// Usage:
//   node svg-color-rinse.mjs file.svg [more.svg ...]   # writes *-rinsed.svg
//   node svg-color-rinse.mjs --in-place exports/       # overwrite, recursive
//   node svg-color-rinse.mjs --dry-run exports/        # report only
//   node svg-color-rinse.mjs --optimize exports/       # rinse + svgo minify
//   node svg-color-rinse.mjs --hue blue --dark "#0b1f5e" art.svg
//   node svg-color-rinse.mjs --black 80 --white 10 --max-saturation 12 art.svg

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import process from 'node:process';

const HUE_NAMES = {
  red: 0, orange: 30, yellow: 60, green: 120, teal: 180, cyan: 180,
  blue: 220, purple: 275, violet: 275, magenta: 320, pink: 330,
};

const HEX_RE = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const RGB_RE = /rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/g;

// ---- color math -----------------------------------------------------------

function parseHex(h) {
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const tintPct = (rgb) => (1 - luma(rgb) / 255) * 100;
const satPct = (rgb) => ((Math.max(...rgb) - Math.min(...rgb)) / 255) * 100;

function hueDeg([r, g, b]) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d === 0) return null;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const hueDist = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

// ---- gates ----------------------------------------------------------------

function buildGates(opts) {
  const gates = [];
  // Neutral gate first: a murky near-gray has a meaningless hue, so it must
  // be claimed here before any hue gate sees it.
  gates.push({
    name: 'neutral',
    matches: (rgb) => satPct(rgb) <= opts.maxSaturation,
    dark: opts.hue === null ? (opts.dark ?? '#000000') : '#000000',
  });
  if (opts.hue !== null) {
    gates.push({
      name: `hue ${opts.hue}°±${opts.tolerance}`,
      matches: (rgb) => {
        const h = hueDeg(rgb);
        return h !== null && hueDist(h, opts.hue) <= opts.tolerance;
      },
      dark: opts.dark, // null -> resolved per file to the darkest match
    });
  }
  return gates;
}

const claimingGate = (rgb, gates) => gates.find((g) => g.matches(rgb)) ?? null;

// For a hue gate with no explicit --dark, anchor heavy tints to the darkest
// color that gate claims in this file. A color counts only if this gate is
// the one that claims it (the neutral gate takes murky near-grays first).
function resolveAnchors(gates, colors, opts) {
  for (const gate of gates) {
    if (gate.dark !== null) continue;
    let best = null;
    for (const rgb of colors) {
      if (claimingGate(rgb, gates) !== gate || tintPct(rgb) < opts.black) continue;
      if (best === null || luma(rgb) < luma(best)) best = rgb;
    }
    gate.dark = best === null ? null : toHex(best);
  }
}

function replacementFor(rgb, gates, opts) {
  const gate = claimingGate(rgb, gates);
  if (gate === null) return null;
  const t = tintPct(rgb);
  let out = null;
  if (t >= opts.black && gate.dark !== null) out = gate.dark;
  else if (t <= opts.white) out = '#ffffff';
  if (out === null || out === toHex(rgb)) return null;
  return { gate: gate.name, color: out };
}

// ---- rinse ----------------------------------------------------------------

function rinse(text, gates, opts) {
  // Pass 1: collect the palette so hue gates can pick their dark anchor.
  const colors = new Map(); // hexNormalized -> rgb
  for (const [, h] of text.matchAll(HEX_RE)) {
    const rgb = parseHex(h);
    colors.set(toHex(rgb), rgb);
  }
  for (const [, r, g, b] of text.matchAll(RGB_RE)) {
    const rgb = [r, g, b].map((v) => Math.min(Number(v), 255));
    colors.set(toHex(rgb), rgb);
  }
  resolveAnchors(gates, colors.values(), opts);

  // Pass 2: rewrite.
  const changes = new Map(); // "old -> new" -> {gate, tint, count}
  const note = (old, res, rgb) => {
    const key = `${old.toLowerCase()} -> ${res.color}`;
    const e = changes.get(key) ?? { old: old.toLowerCase(), new: res.color, gate: res.gate, tint: tintPct(rgb), count: 0 };
    e.count += 1;
    changes.set(key, e);
  };

  let out = text.replace(HEX_RE, (m, h) => {
    const rgb = parseHex(h);
    const res = replacementFor(rgb, gates, opts);
    if (res === null) return m;
    note(m, res, rgb);
    return res.color;
  });
  out = out.replace(RGB_RE, (m, r, g, b) => {
    const rgb = [r, g, b].map((v) => Math.min(Number(v), 255));
    const res = replacementFor(rgb, gates, opts);
    if (res === null) return m;
    note(m, res, rgb);
    return res.color;
  });
  return { out, changes };
}

// svgo is loaded only when --optimize is used, so the base tool stays
// runnable with no dependencies installed. Mirrors process-images' settings:
// preset-default, multipass, viewBox preserved.
let svgoOptimize = null;
async function loadSvgo() {
  try {
    ({ optimize: svgoOptimize } = await import('svgo'));
  } catch {
    console.error('--optimize requires svgo: npm install (or npm install svgo)');
    process.exit(1);
  }
}

async function processFile(file, gates, opts) {
  const text = readFileSync(file, 'utf8');
  const { out: rinsed, changes } = rinse(text, gates, opts);

  console.log(`${path.basename(file)}:`);
  if (changes.size === 0) {
    console.log('  no colors needed rinsing');
  }
  const sorted = [...changes.values()].sort((a, b) => b.tint - a.tint);
  for (const c of sorted) {
    console.log(
      `  ${c.gate.padEnd(10)} ${c.old.padStart(9)} (tint ${c.tint.toFixed(1).padStart(5)}%)` +
      ` -> ${c.new}  [${c.count}x]`
    );
  }

  let out = rinsed;
  if (opts.optimize) {
    out = svgoOptimize(rinsed, { multipass: true, plugins: ['preset-default'] }).data;
    const pct = ((1 - out.length / text.length) * 100).toFixed(1);
    console.log(`  optimized ${text.length.toLocaleString()} -> ${out.length.toLocaleString()} bytes (-${pct}%)`);
  } else if (changes.size === 0) {
    return; // nothing to write
  }

  if (opts.dryRun) return;
  const dest = opts.inPlace
    ? file
    : path.join(path.dirname(file), path.basename(file, '.svg') + '-rinsed.svg');
  writeFileSync(dest, out);
  console.log(`  wrote ${dest}`);
}

// ---- CLI ------------------------------------------------------------------

function collectSvgs(p, out) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p).sort()) collectSvgs(path.join(p, e), out);
  } else if (p.toLowerCase().endsWith('.svg') && !p.toLowerCase().endsWith('-rinsed.svg')) {
    out.push(p);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      black: { type: 'string', default: '80' },
      white: { type: 'string', default: '10' },
      'max-saturation': { type: 'string', default: '12' },
      hue: { type: 'string' },
      tolerance: { type: 'string', default: '30' },
      dark: { type: 'string' },
      optimize: { type: 'boolean', default: false },
      'in-place': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
    const header = [];
    for (const l of lines.slice(1)) { // skip shebang, stop at first code line
      if (!l.startsWith('//')) break;
      header.push(l.slice(3));
    }
    console.log(header.join('\n'));
    process.exit(positionals.length === 0 && !values.help ? 1 : 0);
  }

  let hue = null;
  if (values.hue !== undefined) {
    hue = HUE_NAMES[values.hue.toLowerCase()] ?? Number(values.hue);
    if (Number.isNaN(hue)) {
      console.error(`unknown hue "${values.hue}" (use a name like blue/red or degrees 0-360)`);
      process.exit(1);
    }
  }
  const opts = {
    black: Number(values.black),
    white: Number(values.white),
    maxSaturation: Number(values['max-saturation']),
    hue,
    tolerance: Number(values.tolerance),
    dark: values.dark?.toLowerCase() ?? null,
    optimize: values.optimize,
    inPlace: values['in-place'],
    dryRun: values['dry-run'],
  };
  if (opts.dark !== null && !/^#[0-9a-f]{6}$/.test(opts.dark)) {
    console.error(`--dark must be a #rrggbb hex color, got "${values.dark}"`);
    process.exit(1);
  }

  const files = [];
  for (const p of positionals) collectSvgs(p, files);
  if (files.length === 0) {
    console.error('no SVG files found');
    process.exit(1);
  }
  if (opts.optimize) await loadSvgo();
  for (const f of files) await processFile(f, buildGates(opts), opts);
}

await main();
