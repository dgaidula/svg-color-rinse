# svg-color-rinse

Snap the messy near-blacks and near-whites in AI-generated SVG exports
(Recraft and friends) to clean anchors, so the files are ready for print
work — then optionally minify them with [svgo](https://github.com/svg/svgo).

A vectorized illustration usually comes back with a dozen "blacks"
(`#000`, `#171617`, `#242228`, …) and several "whites" (`#fdfcfd`,
`#eae9eb`, …). Fixing that by hand in Illustrator, shape by shape, is the
tedious part. This tool does it in one pass:

- near-neutral colors at/above **80% tint** → true black `#000000`
- near-neutral colors at/below **10% tint** → true white `#ffffff`
- mid grays are left untouched
- saturated colors are never touched (saturation guard), so a dark navy or
  deep red can't collapse into black

Tint is `1 − luma/255` (Rec.601). Colors are rewritten wherever they appear —
`<style>` blocks, `fill`/`stroke`/`stop-color` attributes, inline `style=""`,
gradient stops — in `#rgb`, `#rrggbb`, and `rgb()` forms. Geometry is never
modified (unless you opt into `--optimize`).

## Install

```sh
# run without installing
npx svg-color-rinse art.svg

# or install globally
npm install -g svg-color-rinse
svg-color-rinse art.svg

# or from a clone (no install needed unless you want --optimize)
node svg-color-rinse.mjs art.svg
```

Requires Node 20+. The rinse itself has **zero dependencies**; svgo is only
loaded when you pass `--optimize`.

## Quick start

```sh
# one file -> writes art-rinsed.svg alongside it
svg-color-rinse art.svg

# preview what would change, write nothing
svg-color-rinse --dry-run art.svg
```

Output is a per-file report of every color it touched, with the tint it
measured and how many times the color occurred:

```
art.svg:
  neutral      #171617 (tint  91.2%) -> #000000  [1x]
  neutral    rgb(23, 22, 23) (tint  91.2%) -> #000000  [1x]
  neutral      #242228 (tint  86.2%) -> #000000  [1x]
  neutral      #eae9eb (tint   8.4%) -> #ffffff  [1x]
  neutral      #fdfcfd (tint   1.0%) -> #ffffff  [1x]
  wrote art-rinsed.svg
```

## Batch a whole folder

Directories are processed recursively (previously written `*-rinsed.svg`
files are skipped automatically), and shell globs work as you'd expect:

```sh
svg-color-rinse exports/                 # every .svg under exports/, output *-rinsed.svg
svg-color-rinse --in-place exports/      # same, but overwrite the originals
svg-color-rinse batch1/ batch2/ one-off.svg
svg-color-rinse exports/*.svg            # shell glob
```

## Tune the thresholds

```sh
# fold in that one 79% gray that just misses the default gate
svg-color-rinse --black 79 art.svg

# stricter white gate, looser neutral detection
svg-color-rinse --white 6 --max-saturation 15 art.svg
```

## Hue gates: the same cleanup for a color family

If the artwork is built on blues (or any hue) instead of blacks, `--hue`
applies the same gate to that family: heavy tints merge into one dark anchor,
pale tints wash to white.

```sh
# merge heavy blues into the darkest blue already in the file
svg-color-rinse --hue blue art.svg

# pin the anchor yourself and tighten the hue window (default ±30°)
svg-color-rinse --hue 220 --tolerance 25 --dark "#0a1123" art.svg
```

```
blue-variant.svg:
  neutral      #0a1123 (tint  93.3%) -> #000000  [1x]
  hue 220°±30   #101c37 (tint  89.2%) -> #0a1123  [1x]
  hue 220°±30   #172951 (tint  84.2%) -> #0a1123  [1x]
```

Hue names: `red`, `orange`, `yellow`, `green`, `teal`/`cyan`, `blue`,
`purple`/`violet`, `magenta`, `pink` — or pass degrees 0–360.

Precedence: the neutral gate runs first, so a murky near-gray (saturation ≤
`--max-saturation`) always counts as black/white territory; the hue gate only
claims genuinely colored fills. With no `--dark`, the hue gate anchors to the
darkest color it claims in each file — "make all the heavy blues the same
blue".

## Quantizing mid-grays

AI vectorizers don't just scatter near-blacks and near-whites — the mid-grays
in between are often jittered too, a dozen barely-different fills like
`#3a3d3b`, `#3b3e3c`, `#3c383a` where a human designer would have used one.
Left alone, each of those becomes its own slightly-different tint on press.

`--quantize N` snaps every surviving neutral mid-tone (saturation ≤
`--max-saturation`, tint strictly between `--white` and `--black` — the
colors the gates leave untouched) onto the nearest of N evenly spaced tint
levels: `i/(N+1)` for `i = 1..N`. `--quantize 4` gives levels at 20%, 40%,
60%, 80% tint; each survivor moves to whichever level it's closest to, output
as a neutral gray hex (`round(255 × (1 − level))` per channel).

```sh
svg-color-rinse --quantize 4 art.svg
```

```
art.svg:
  quantize     #3c383a (tint  77.5%) -> #333333  [1x]
  quantize     #3a3d3b (tint  76.5%) -> #333333  [1x]
  quantize     #3b3e3c (tint  76.1%) -> #333333  [1x]
```

A color already sitting exactly on a level is left alone (no self-replacement
row). Quantizing runs after the gates and combines cleanly with `--hue` and
`--optimize`. It only ever touches neutral mid-tones: colors claimed by a hue
gate (saturation above `--max-saturation`) are never quantized, even if they
sit in the same jittered-mid-tone territory — see `CLAUDE.md` for the
reasoning and the workaround.

## Optimize with svgo

`--optimize` runs svgo on each file after rinsing — `preset-default`,
multipass, viewBox preserved (the same settings as
[process-images](https://github.com/dgaidula/process-images)):

```sh
svg-color-rinse --optimize exports/
```

```
art.svg:
  neutral      #171617 (tint  91.2%) -> #000000  [1x]
  ...
  optimized 409,517 -> 381,113 bytes (-6.9%)
  wrote art-rinsed.svg
```

Savings depend on how tight the export already is: a full-page Illustrator
re-export trims ~7%, while rawer generator output compresses much harder
(the test fixture drops 64%).

With `--optimize`, files that needed no color fixes are still optimized and
written.

## Options

| flag | default | meaning |
|---|---|---|
| `--black <pct>` | 80 | tint at/above which darks snap to the dark anchor |
| `--white <pct>` | 10 | tint at/below which lights wash to `#ffffff` |
| `--max-saturation <pct>` | 12 | neutral-gate saturation ceiling, `(max−min)/255` |
| `--hue <name\|deg>` | off | add a hue gate for that color family |
| `--tolerance <deg>` | 30 | hue window for the hue gate |
| `--dark <#rrggbb>` | auto | dark anchor for the hue gate (darkest claimed color if omitted) |
| `--quantize <N>` | off | snap surviving neutral mid-grays onto N evenly spaced tint levels |
| `--optimize` | off | run svgo (preset-default, multipass, keep viewBox) after rinsing |
| `--in-place` | off | overwrite inputs instead of writing `*-rinsed.svg` |
| `--dry-run` | off | report only, write nothing |
| `--help` | | print usage |

## The remaining print step

SVG cannot hold CMYK separations or ICC profiles, so a warm-rich-black
conversion still happens in a CMYK-capable tool — but on a rinsed file it's a
one-shot Illustrator Recolor: map `#000000` to your Rich Black spot swatch
(e.g. CMYK 40/60/40/100) and the handful of surviving grays fall onto its
tints (Illustrator's Dot Gain 20% grayscale conversion lands them at roughly
`gray tint × 1.08`). Record it once as an Action and batch it.

## Development

```sh
npm install   # svgo, for the --optimize tests
npm test      # node --test against the fixtures in test/
```

## License

MIT
