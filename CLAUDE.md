- When you start a session always read the docs and what is next for work
- When writing code comments, never use icons and emojis. Keep comments technical and focused on implementation details. Comments must explain what the code does, not session-related context.

## RSC Router Layout Composition

Layouts compose by position, not nesting. Order in array = wrapping order:

```typescript
layout(<A />),     // wraps everything below
layout(<B />),     // stacks on A
route("x", ...),   // gets A → B
route("y", ...),   // gets A → B
```

Routes can add scoped layouts:
```typescript
layout(<Shared />),
route("x", () => [layout(<OnlyForX />)]),  // Shared → OnlyForX → x
route("y"),                                 // Shared → y
```

Revalidation: route-scoped layouts get `defaultShouldRevalidate: true` when their route revalidates. Top-level layouts don't.