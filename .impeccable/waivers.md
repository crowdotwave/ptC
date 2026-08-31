# Detector waivers, and why

`.impeccable/config.json` holds the waivers. Two of them are rule-level, and the config format
stores a rule-level waiver as a bare string with nowhere to put a reason, so the reasons are here.
Value-level waivers keep their reason in the config itself and are not repeated.

A waiver here means the detector found a real pattern and this project made the opposite decision
on purpose, with the reasoning written down in CLAUDE.md. It does not mean the rule is wrong. If
you are about to widen one, read the CLAUDE.md section named under it first: these are the
decisions most likely to be undone by somebody clearing a warning.

## `dark-glow`, waived project wide

The detector's reading: a zero-offset chromatic halo on a dark background is the default "cool"
look of AI-generated UIs.

Why this project keeps it: glow here is a defined, measured, and fenced part of the palette, not a
finish applied for looks. CLAUDE.md's **Glow** section defines exactly two intensities,
`--glow-rest` and `--glow-celebrate`, and fences them to fills, borders, container edges and chart
strokes. It bars them from sitting on or behind any text read mid set, because glow spreads light
into its surroundings and lowers effective contrast, and glare is the failure mode the whole
palette exists to survive.

The alternative the rule proposes, neutral elevation shadows, is not available. The base surface is
pitch black on an OLED panel, and a black drop shadow on a black base separates nothing. CLAUDE.md
states the consequence directly: there is no drop shadow anywhere in this app and there cannot be.
Objects are lifted by light on their own edges instead.

Waived at the rule rather than per colour because the tint is derived from whichever accent the
element already carries, so the set of hues is open by design. What is closed is where a glow may
appear, and that fence is enforced by review against the Glow section, not by this detector.

## `side-tab`, waived project wide

The detector's reading: a thick coloured border on one side of a card is a recognisable tell of
AI-generated UIs.

Why this project keeps it: CLAUDE.md's **Encoding rules** ban hue-only encoding outright. Any state
that carries meaning must also carry a shape, a weight, a position, or a word, because fine hue
discrimination degrades mid effort, under glare, with sweat on the glass. The left bar on
`.import__row--review` is that second channel. Removing it, or softening it to the point where it
reads as decoration, leaves the row's state encoded in a tint alone, which is the exact failure the
rule set exists to prevent.

There is one site today. Waived at the rule because the encoding rule applies app wide and the next
row that needs a look will be drawn the same way.

## Not waived, and left visible on purpose

- **`monotonous-spacing`**, reported as roughly 4px in about 91% of sampled values, on every page.
  Checked, and it is wrong. The scale is in real use across all six steps: `--s-2` appears 73
  times in `styles.css`, `--s-3` 64, `--s-4` and `--s-1` 41 each, `--s-5` ten and `--s-6` once.
  That is a distribution, not one value repeated. The rule reports an identical ratio on pages as
  different as the login screen and the trainer view, which is the tell that it samples a narrow
  fixed set of computed values rather than the page's own rhythm.

  Still not waived. It costs one line of noise per page and it is the only rule here anybody has
  had to argue with, so leaving it visible keeps the argument in front of whoever reads this next.
  Waive it if it starts drowning a real finding.
- **`overused-font`** is waived only for the two faces a system stack resolves to on the machines
  this has been scanned from. The rule stays live, so an actual webfont choice would still be
  reported and would still deserve the argument. See the `--font` token in `styles.css`.
