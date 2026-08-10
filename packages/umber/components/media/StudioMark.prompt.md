**StudioMark** — Comparative's open working-frame companion to the Orb. It inherits `currentColor`, plays a quiet one-shot entrance, and honors reduced motion.

```jsx
<StudioMark label="Contribution Studio" size={28} />
<StudioMark state="working" size={18} />
<StudioMark animated={false} size={16} />
```

States: `idle` (settles after its entrance) · `working` (settles, then keeps a low-amplitude organic motion). Set `animated={false}` for a static frame. In plain HTML the registered element works directly: `<comparative-studio-mark state="idle" size="28"></comparative-studio-mark>`.
