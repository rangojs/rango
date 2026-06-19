# @rangojs/router

A file-system based React Server Components router.

Run `/rango` to understand the API. Detailed guides for each feature are in the `skills/` directory (e.g. `node_modules/@rangojs/router/skills/loader`, `skills/caching`, `skills/middleware`, etc.).

## Development rules

- Always commit generated files (e.g. `*.gen.ts`) alongside the source changes that produced them.

## Repo-wide rules (read before pushing)

This package inherits the repo-wide conventions in the root [`AGENTS.md`](../../AGENTS.md) and [`CLAUDE.md`](../../CLAUDE.md). The ones a package-scoped reader is most likely to miss:

- **Pre-push gate** — before EVERY push, run all of the following from the **repo root** and fix any failures: `pnpm run typecheck`, `pnpm run test:unit:all`, `pnpm run lint`, `pnpm run format`.
- **`test:unit:all` is recursive** — it runs the unit AND Flight/RSC suites for every package and consumer app (cloudflare-basic, mini, vite-rsc-demo, ...), not just `@rangojs/router`. A change can pass this package's own tests while breaking a consumer app's `@rangojs/router/testing` dogfood suite, so do not run only `pnpm --filter @rangojs/router test:unit`.
- **Dev + prod e2e parity is mandatory** — every e2e test must cover BOTH dev and production modes; never add a dev-only test without its production counterpart. See the dev/prod bucketing convention in the root `AGENTS.md`.
