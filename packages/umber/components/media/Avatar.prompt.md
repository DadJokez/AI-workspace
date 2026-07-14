**Avatar** — identity token for people, agents, and apps.

```jsx
<Avatar name="Ada Lindmark" />                       {/* initials, circle */}
<Avatar icon="bot" shape="square" tone="pop" />      {/* an agent */}
<Avatar src="/team/ada.jpg" name="Ada Lindmark" size={40} />
```

People are circles; agents and apps use `shape="square"`. Reserve `tone="pop"` for the one agent or app in focus.
