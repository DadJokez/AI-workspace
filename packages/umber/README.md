# @ai-workspace/umber — vendored Umber design system

Comparative's visual identity. This package is a **vendored copy** of the
Umber design system; the source of truth is
[DadJokez/umber-design-system](https://github.com/DadJokez/umber-design-system)
(local clone at `~/design-system/umber`).

## Rules

- **Never edit `tokens/`, `components/`, `assets/`, `styles.css`, or `SKILL.md`
  here.** Change the design system upstream (commit + push there), then re-run
  `scripts/sync-umber.sh` from the repo root to re-vendor. Only `package.json`
  and this README belong to this repo.
- Components are React (`.jsx` + `.d.ts` + `.prompt.md`) consuming Umber CSS
  custom properties. Deep-import what you need, e.g.
  `import { Button } from "@ai-workspace/umber/components/forms/Button"`.
  The web app transpiles this package (`transpilePackages` in next.config).
- The brand mark is the `Orb` component
  (`components/media/Orb.jsx`) — never recreate or approximate it by hand.
- Reserve the forest-green pop (`--pop`) for ONE action per view. Sentence
  case. No emoji. Hairline borders over heavy shadows. 4px corners.

## How Comparative consumes it

The app's Tailwind theme reads eight semantic RGB-triplet variables
(`--color-canvas`, `--color-surface`, …) defined in `apps/web/app/globals.css`.
The Umber skin remaps those triplets under `html[data-skin="umber"]`
(light + dark), so the existing Tailwind classes rebrand at runtime. Umber
components additionally need the token custom properties from `tokens/`,
loaded where those components mount.
