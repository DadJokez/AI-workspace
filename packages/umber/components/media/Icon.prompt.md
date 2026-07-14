**Icon** — renders a [Lucide](https://lucide.dev) glyph by name, inheriting `currentColor`. Umber's documented icon primitive (intentional addition — no source icon set was provided).

```jsx
<Icon name="database" size={18} />
<Button iconLeft={<Icon name="plus" size={15} />}>New warehouse</Button>
```

Extend the `ICONS` map in `Icon.jsx` by pasting more path data from lucide.dev. Keep stroke width at 2 for consistency.
