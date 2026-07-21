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

The app imports Umber's decision tokens globally in
`apps/web/app/globals.css`. Tailwind's semantic colors point directly to those
tokens, so every component uses the same Umber identity in light and dark
themes. The root layout applies the stored theme before first paint and the
client theme hook re-asserts it after React hydration. Umber components use
the same token custom properties from `tokens/`.
