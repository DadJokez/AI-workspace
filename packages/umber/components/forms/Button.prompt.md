**Button** — the primary action primitive; use it for anything the user clicks to *do* something.

```jsx
<Button variant="solid" onClick={save}>Save changes</Button>
<Button variant="pop" iconLeft={<Icon name="sparkles" />}>Generate</Button>
<Button variant="outline" size="sm">Cancel</Button>
```

Variants: `solid` (ink black, the default action), `accent` (tan — soft emphasis), `pop` (forest green — reserve for one hero action per view), `outline`, `ghost`, `link`. Sizes: `sm | md | lg`. Supports `iconLeft` / `iconRight`, `loading`, `disabled`, `fullWidth`.
