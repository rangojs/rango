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

## Intercepting Routes

Intercepts render alternative content in a named slot during soft navigation (client-side). Hard navigation (direct URL) renders the normal route.

```typescript
layout(<KanbanLayout />, () => [
  loader(KanbanLoader),

  // Intercept card route - renders in @modal slot instead of default Outlet
  intercept("@modal", "card", <CardModal />, () => [
    loader(CardDetailLoader),
    revalidate(() => false),
  ]),
]),

route("card", () => <CardDetailPage />),  // Hard navigation renders this
```

API:
- `intercept(slotName, routeName, component, children?)`
  - `slotName`: Named slot (e.g., `"@modal"`)
  - `routeName`: Route key to intercept
  - `component`: React element to render
  - `children`: Optional - loaders, revalidate, middleware

In the layout, use `<Outlet name="@modal" />` to render intercept content:

```tsx
function KanbanLayout() {
  return (
    <div>
      <KanbanBoard />
      <Outlet name="@modal" />  {/* Intercept content renders here */}
      <Outlet />                 {/* Normal route content */}
    </div>
  );
}
```