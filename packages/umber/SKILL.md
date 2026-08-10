---
name: umber-design
description: Use this skill to generate well-branded interfaces and assets for Umber, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.
If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.
If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Quick orientation

- **One stylesheet.** Link `styles.css` — it `@import`s every token file and the base reset. All design decisions are CSS custom properties (`--tan-200`, `--text-muted`, `--radius-sm`, `--shadow-md`, …). Read `tokens/` for the full set.
- **Themes.** Default is light. Set `data-theme="dark"` on `<html>` (or any scope) for the warm dark theme.
- **Components** live in `components/<group>/` as React files. In HTML/prototypes, load the compiled bundle `_ds_bundle.js` and read `window.UmberDesignSystem_5c2597` (e.g. `const { Button, Card, Icon } = window.UmberDesignSystem_5c2597`). Each component has a `.prompt.md` with a usage example.
- **Icons** — use the `Icon` component (`<Icon name="database" />`); names are Lucide glyphs. Extend the map in `components/media/Icon.jsx`.
- **Comparative marks** — use `Orb` for chat and `StudioMark` for Contribution Studio. Both inherit `currentColor`; never redraw either mark in product code.
- **Templates** — `templates/deck/` and `templates/white-paper/` are ready starting points.
- **Reference app** — `ui_kits/console/` shows the components composed into a real product.

## Non-negotiables (the brand in one breath)

- Warm blacks + parchment tan. Forest-green pop used **once** per view, never as decoration.
- Geist for UI/body, Newsreader (serif) for display only, Geist Mono for data/labels.
- Sentence case. No emoji. Plain, second-person, present-tense copy with real numbers.
- Hairline borders over heavy shadows. Gentle 4px corners. Quiet, fast motion.
- A whisper of paper grain on backgrounds — never a visible pattern or gradient.
