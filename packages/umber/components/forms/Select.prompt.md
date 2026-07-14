**Select** — native dropdown styled to the form family.

```jsx
<Select label="Region" placeholder="Choose a region"
  options={["us-west-2", "us-east-1", "eu-central-1"]} />
```

Pass `options` (strings or `{value,label}`) or raw `<option>` children. Sizes `sm | md | lg`. Supports `label`, `hint`, `error`, `disabled`.
