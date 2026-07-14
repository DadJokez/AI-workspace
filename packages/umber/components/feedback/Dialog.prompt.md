**Dialog** — centered modal with scrim, title, body, and footer actions. Controlled via `open`/`onClose`; closes on scrim click and Escape.

```jsx
<Dialog open={open} onClose={close} title="Delete warehouse?"
  description="This cannot be undone."
  footer={<>
    <Button variant="ghost" onClick={close}>Cancel</Button>
    <Button variant="pop" onClick={confirm}>Delete</Button>
  </>}>
  Queries in flight will be cancelled.
</Dialog>
```
