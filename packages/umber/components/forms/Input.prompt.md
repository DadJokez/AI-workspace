**Input** — single-line text field with built-in label, hint, and error handling.

```jsx
<Input label="Workspace name" placeholder="Acme Analytics" hint="Shown across the console." />
<Input label="Endpoint" prefix="https://" iconLeft={<Icon name="link" />} />
<Input label="Email" error="That address is already in use." defaultValue="x@y" />
```

Sizes `sm | md | lg`. Pass `iconLeft`, `prefix`, `disabled`. Sets `aria-invalid` when `error` is present.
