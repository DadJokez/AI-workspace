**RadioGroup / Radio** — single-choice selection. `RadioGroup` owns the state; `Radio` renders one option.

```jsx
<RadioGroup defaultValue="on-demand" onChange={setBilling}
  options={[
    { value: "on-demand", label: "On-demand", description: "Pay per query." },
    { value: "committed", label: "Committed use", description: "Reserved capacity." },
  ]} />
```

Pass `options` or `<Radio>` children.
