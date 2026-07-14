**Orb** — the animated brand mark and AI-activity indicator. Inherits `currentColor`.

```jsx
<Orb label="Comparative" size={28} />                     {/* brand mark, idle */}
<Orb state="thinking" size={16} color="var(--pop)" />     {/* work underway */}
<Orb state="responding" energy={tokens} size={32} />      {/* streaming; bump energy */}
```

States: `idle` (branding / at rest) · `thinking` (before output) · `responding` (while content streams — feed increasing `energy`). Set `animated={false}` for a static frame. In plain HTML the registered element works directly: `<comparative-orb state="idle" size="28"></comparative-orb>`.
