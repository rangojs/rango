# @rangojs/router — agent guide

Django-inspired React Server Components router: routes are an explicit `urls()` tree (`path()`, `layout()`, `include()`) — not a file-system convention — with type-safe named routes and `href`/`reverse`.

Start with the mental model at `node_modules/@rangojs/router/skills/rango/SKILL.md`, then the per-feature guides in the sibling directories (`skills/loader`, `skills/caching`, `skills/middleware`, etc.). If your harness supports slash-command skills and neither target path already exists, install `/rango` with `npx skills add ./node_modules/@rangojs/router --skill rango --agent universal --agent claude-code`; `/rango` is the same document. The canonical consumer `AGENTS.md` block is `node_modules/@rangojs/router/skills/rango/agent-rules.md`.

## Development rules

- After adding, removing, or renaming routes, run `npx rango generate src/` and commit the regenerated `*.gen.ts` files alongside the source change.

## Contributing

This package is developed in the monorepo at https://github.com/ivogt/vite-rsc. If you are contributing there rather than consuming the published package, read the root `AGENTS.md` in that repo for the pre-push gate and e2e rules — they apply to the monorepo, not to consumer apps.
