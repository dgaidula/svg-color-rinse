# svg-color-rinse — maintainer notes

Agent-facing notes for future Claude sessions working on this repo. The
README is for users; this file is for whoever next touches
`svg-color-rinse.mjs`.

## Architecture in one pass

Everything lives in `svg-color-rinse.mjs` (single file, zero required deps —
svgo is dynamically imported only for `--optimize`). Per file, `rinse(text,
gates, opts)` runs three passes over the source text:

1. **Collect** — regex-scan every `#rgb`/`#rrggbb`/`rgb()` occurrence into a
   `hex -> rgb` map. This is only so hue gates can find their darkest match
   before any rewriting happens (`resolveAnchors`).
2. **Gates** — regex-replace every color occurrence. Each color asks
   `claimingGate(rgb, gates)`, which is `gates.find(...)` — **first match
   wins**. `gates[0]` is always the neutral gate (`saturation <=
   --max-saturation`); a hue gate (`--hue`), if present, is `gates[1]`. This
   ordering is deliberate and load-bearing: a murky near-gray has a
   meaningless hue, so it must never reach the hue gate. See `buildGates`.
   A claimed color only actually gets rewritten if its tint clears the
   black/white threshold (`replacementFor`); anything with tint strictly
   between `--white` and `--black` is left as-is by this pass.
3. **Quantize** (`--quantize N`, new in 1.1.0) — a second regex-replace pass
   over the *already-gate-rewritten* text. This is why it's pass 3, not
   folded into pass 2: it operates on whatever the gates left untouched, so
   it must run strictly after them. See "Quantize" below.

Everything after `rinse()` (the `changes` report, `--optimize`, writing the
file) is pipeline plumbing and didn't need to change for this feature.

## The claiming/precedence model

- `claimingGate` = first gate in the `gates` array whose `matches(rgb)` is
  true. There is no "best match" — order encodes precedence.
- A gate's `dark` anchor is either fixed (`--dark`, or `#000000` for the
  neutral gate) or resolved once per file to the darkest color that gate
  (specifically, not a higher-precedence gate) claims at/above `--black`
  tint (`resolveAnchors`).
- **Invariant: anchors are never remapped.** `replacementFor` bails via
  `out === toHex(rgb)` — if a color already equals its own target, no row is
  emitted and the text is untouched. Quantize follows the same pattern
  (`quantizeReplacementFor` returns `null` if the quantized gray equals the
  input exactly) — this is also how "a color already on a level" is a no-op
  rather than a special case.
- **Invariant: saturated colors are never touched by the neutral/quantize
  path.** `satPct(rgb) > opts.maxSaturation` is an early bail in both
  `buildGates`'s neutral matcher and `quantizeReplacementFor`. Don't relax
  this without re-reading why (dark navy / deep red must never collapse to
  black, and jittered saturated hues must never collapse to gray).

## Quantize: what it does and why it's separate from the gates

`--quantize N` (`svg-color-rinse.mjs`, "quantize" section) snaps every
surviving neutral mid-tone onto the nearest of N evenly spaced tint levels,
`level_i = i/(N+1)` for `i = 1..N`. Output is a neutral gray hex where each
channel is `round(255 * (1 - level))`.

Eligibility (`quantizeReplacementFor`) is intentionally the *complement* of
what the gates already claimed, not an independent check:

```
satPct(rgb) <= opts.maxSaturation   // same ceiling as the neutral gate
opts.white < tintPct(rgb) < opts.black   // the gap the gates leave alone
```

It is **not** a gate in the `gates` array/`buildGates` sense — it doesn't
participate in `claimingGate` precedence, has no anchor-resolution step, and
runs as a distinct pass 3 after both gate passes have already rewritten the
text. Treat "gates" and "quantize" as two different pipeline stages: gates
decide anchors (black/white/hue-dark), quantize decides mid-tone buckets.
Keep that separation if you extend either — don't fold quantize's matching
into `buildGates`, and don't give quantize its own anchor-resolution logic.

Report rows use gate label `"quantize"` and go through the *same* `note()`
closure as gate rows, so they interleave in the tint-sorted report exactly
like any other row — no separate report path was needed.

## Known limitation: hue-gate mid-tones are never quantized

By construction, `quantizeReplacementFor` only accepts colors with
`satPct(rgb) <= opts.maxSaturation`. A saturated mid-tone that a hue gate's
window would have claimed (say, a jittered mid-blue at 50% tint that
`--hue blue` leaves alone because it's below `--black`) is *not* touched by
`--quantize` even though it's conceptually the same "jittery mid-tone AI
export" problem. This is deliberate for 1.1.0 — quantizing hue mid-tones
would need a per-hue tint ramp (and probably a chroma-preserving quantize,
not a collapse-to-gray one), which is out of scope here. If asked to extend
this: don't just loosen the saturation check, since that would gray out
genuinely colored fills. A real fix means adding a hue-aware quantize path
that outputs tinted-not-gray colors.

Workaround today: run `--hue` and `--quantize` in the same invocation (they
compose fine) and accept that hue-family mid-tones pass through unchanged;
or omit `--hue` and let `--max-saturation` swallow the murkier ones into the
neutral/quantize path if that's an acceptable trade for the artwork at hand.

## Test strategy

`test/cli.test.mjs` is black-box: it shells out to the CLI (`execFileSync`)
against fixtures in `test/fixtures/*.svg` and asserts on stdout (`--dry-run`
report lines) and/or the written `*-rinsed.svg` palette. No unit tests
against the internal functions — the CLI surface *is* the contract.

Conventions to keep:
- One fixture per feature area (`grays.svg`, `blues.svg`, `mids.svg` for
  quantize), each file-header-commented with the expected tint/outcome per
  shape so the fixture doubles as documentation.
- Dry-run assertions use `assert.match`/`assert.doesNotMatch` against
  regexes over the report text, not brittle full-string equality, since row
  order depends on tint sorting.
- At least one test per feature writes the file for real (via a
  `mkdtempSync` scratch dir) and asserts the *palette* of the output
  (`new Set(text.match(/#.../g))`), to catch anything that only shows up in
  the written file vs. the report.
- When adding a fixture color, compute its actual tint/saturation/target
  with a one-off `node -e` snippet (see git history for the quantize
  fixture) rather than hand-picking hex values — the luma/saturation math is
  exact and it's easy to accidentally pick a color that lands in the wrong
  bucket or trips a different gate.
- Invalid-input tests (`--quantize 0`, `-1`, `2.5`, `abc`) use
  `assert.throws` around `execFileSync`, since the CLI exits non-zero on bad
  input. Note: Node's `parseArgs` treats a bare `-1` after `--quantize` as
  option-like and errors before reaching our own validation — pass
  `--quantize=-1` (`=` form) in tests that need a literal negative number.

## Release steps

1. Bump `version` in `package.json` (semver: this repo is pre-1.0-consumer
   but already tags releases; a new flag with no breaking changes is a minor
   bump, e.g. 1.0.0 -> 1.1.0).
2. `npm test` — must be all green.
3. Update README (option table + feature section) and this file if the
   architecture/invariants/limitations changed.
4. Commit and push to `origin main`.
5. **Do not run `npm publish` yourself** — the repo owner publishes to npm
   manually. Your job ends at a pushed, green, documented commit on main.
