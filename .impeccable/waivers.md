# The design detector, and what it is allowed to say

## What is installed here, and what is not

The detector only. Run it by hand:

```bash
npx impeccable detect styles.css index.html progress.html js app.js
```

There is no skill, no `/impeccable` command, and no hook. Nothing is vendored into this repo, so
`npx` fetches the CLI when you ask for it and nothing sits in the tree between runs. That is
deliberate rather than an unfinished install, and the reasoning is worth keeping because the
obvious next step is to install the rest.

It was all installed once and measured. Of ten findings on this codebase, one was real: both timer
tracks animated `width`, which lays the screen out again every frame on the two screens that can
least afford it (the rest timer is read mid set, and the EMOM track redraws against a clock nobody
can pause). That is fixed, and `js/track.js` owns the fix.

Of the other nine, six were the detector telling this project that decisions in CLAUDE.md were
mistakes, two were unfixable or false, and one was a duplicate. Those six are the two rules waived
below. The skill layer on top of it opens by instructing itself to "go all out, dream big and bold"
and to act as an award winning design director, which is guidance written for a project with no
design system. This one has an unusually specific design system with measured contrast ratios in
it, so the overlap was near total and the disagreements went the wrong way.

So: the detector earns its place as a regression check, at zero cost in the tree. The rest did not.

## The two waived rules

The config stores a rule level waiver as a bare string with nowhere to put a reason, so the reasons
live here. A waiver means the detector found a real pattern and this project made the opposite
decision on purpose, with the argument written down in CLAUDE.md. It does not mean the rule is
wrong in general. If you are about to widen one, read the CLAUDE.md section named under it first:
these are the decisions most likely to be undone by somebody clearing a warning.

### `dark-glow`

Its reading: a zero offset chromatic halo on a dark background is the default "cool" look of AI
generated UIs.

Why this project keeps it: glow here is a defined, measured and fenced part of the palette, not a
finish applied for looks. CLAUDE.md's **Glow** section defines exactly two intensities,
`--glow-rest` and `--glow-celebrate`, fences them to fills, borders, container edges and chart
strokes, and bars them from sitting on or behind any text read mid set, because glow lowers
effective contrast and glare is the failure mode the palette exists to survive.

The alternative it proposes, neutral elevation shadows, is not available. The base surface is pitch
black, and a black drop shadow on a black base separates nothing. CLAUDE.md states the consequence
directly: there is no drop shadow anywhere in this app and there cannot be. Objects are lifted by
light on their own edges instead.

Waived at the rule rather than per colour because the tint derives from whichever accent the
element already carries, so the set of hues is open by design. What is closed is where a glow may
appear, and that fence is held by review against the Glow section, not by this detector.

### `side-tab`

Its reading: a thick coloured border on one side of a card is a recognisable tell of AI generated
UIs.

Why this project keeps it: CLAUDE.md's **Encoding rules** ban hue-only encoding outright. Any state
carrying meaning must also carry a shape, a weight, a position or a word, because fine hue
discrimination degrades mid effort, under glare, with sweat on the glass. The left bar on
`.import__row--review` is that second channel. Soften it to decoration and the row's state is
encoded in a tint alone, which is the exact failure the rule set exists to prevent.

One site today, waived at the rule because the encoding rule is app wide and the next row that
needs a look will be drawn the same way.

## Not waived, on purpose

**`monotonous-spacing`**, reported as roughly 4px in about 91% of sampled values, on every page.
Checked, and it is wrong. The scale is in real use across all six steps: `--s-2` appears 73 times
in `styles.css`, `--s-3` 64, `--s-4` and `--s-1` 41 each, `--s-5` ten and `--s-6` once. That is a
distribution, not one value repeated. It reports an identical ratio on pages as different as the
login screen and the trainer view, which is the tell that it samples a narrow fixed set of computed
values rather than the page's own rhythm.

Left visible anyway. It costs one line per page and it is the only rule here anybody has had to
argue with, so leaving it in view keeps the argument in front of whoever reads this next. Waive it
if it ever starts drowning a real finding.

**`overused-font`** is waived only for the two faces a system stack resolves to on the machines this
has been scanned from, so an actual webfont choice would still be reported and would still deserve
the argument. The rule cannot be satisfied by editing the stack: it names whichever face the
scanning machine resolves `ui-sans-serif` / `system-ui` to, which was Roboto from Linux and became
Helvetica once Roboto was removed. See the `--font` token in `styles.css`.
