**Spinner** — quiet indeterminate progress. Inherits `currentColor`.

```jsx
<Spinner />
<Spinner size={20} style={{ color: "var(--pop)" }} />
<Button variant="pop" disabled><Spinner size={14} /> Deploying…</Button>
```

Use for agent work in progress. Prefer over any bouncing-dots or bar animation.
