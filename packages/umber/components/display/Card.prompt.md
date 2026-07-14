**Card** — the primary surface container. Hairline border + whisper shadow, not heavy elevation.

```jsx
<Card>
  <CardHeader title="Usage this month" description="Across all warehouses"
    action={<Badge>Live</Badge>} />
  <p>…</p>
</Card>
<Card interactive onClick={open}>Clickable card</Card>
```

Props: `padding` (sm/md/lg), `interactive` (hover lift), `elevated`, `as`. `CardHeader` gives title/description/action.
