# D1, KV, and local parity

## Contents

- [Provision bindings](#provision-bindings)
- [Apply D1 migrations](#apply-d1-migrations)
- [Use bindings](#use-bindings)
- [Load local secrets](#load-local-secrets)
- [Test dev and production-shaped preview](#test-dev-and-production-shaped-preview)

## Provision bindings

Create real resource IDs before the first deploy:

```bash
pnpm exec wrangler d1 create my-app
pnpm exec wrangler kv namespace create CACHE_KV
```

Copy the returned IDs into `wrangler.json`:

```json
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app",
      "database_id": "<d1-id>",
      "migrations_dir": "migrations"
    }
  ],
  "kv_namespaces": [{ "binding": "CACHE_KV", "id": "<kv-id>" }]
}
```

Do not deploy placeholder IDs. Keep binding names identical in `wrangler.json`
and `AppBindings`; `ctx.env.DB` is the configured binding, not a global.

## Apply D1 migrations

```bash
# Generate SQL with your migration tool first, then:
pnpm exec wrangler d1 migrations apply my-app --local
pnpm exec wrangler d1 migrations apply my-app --remote
```

The Cloudflare Vite plugin and `wrangler d1 ... --local` use the same local
Miniflare persistence for the project. A migration applied through the CLI is
therefore visible to both `vite dev` and `vite preview`; treat the internal
`.wrangler/state` layout as an implementation detail.

Add a real handler probe while setting up the binding, then remove it after the
first production-shaped test:

```typescript
path.json("/__db-check", async (ctx) => {
  const row = await ctx.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users",
  ).first<{
    n: number;
  }>();
  return { ok: true, users: row?.n ?? 0 };
});
```

## Use bindings

Handlers, loaders, and middleware all receive the same typed bindings:

```typescript
export const UserLoader = createLoader(async (ctx) =>
  ctx.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(ctx.params.id)
    .first(),
);

export const requireSession: Middleware = async (ctx, next) => {
  const token = cookies().get("session")?.value;
  const session = token
    ? await ctx.env.DB.prepare("SELECT * FROM sessions WHERE token = ?")
        .bind(token)
        .first()
    : null;
  if (!session) return redirect("/login");
  return next();
};
```

D1 has no Postgres RLS. Moving from an RLS-backed database requires an
authorization-aware data-access layer that checks actor/tenant membership as
part of every query. Do not translate SQL tables while silently dropping RLS.

## Load local secrets

Keep `.dev.vars` out of git and commit `.dev.vars.example` with names only:

```dotenv
SESSION_SECRET=
STRIPE_WEBHOOK_SECRET=
```

Loading differs by command:

| Command        | Source                                                      |
| -------------- | ----------------------------------------------------------- |
| `vite dev`     | live project `.dev.vars`                                    |
| `vite preview` | `dist/<environment>/.dev.vars` copied during the last build |
| `wrangler dev` | project `.dev.vars`                                         |

Rebuild after changing `.dev.vars` before testing preview. Use
`wrangler secret put NAME` for production secrets; `.dev.vars` is local only.

Keep behavior-forcing e2e flags separate from a developer's default local
profile. A copied `.dev.vars.example` that enables every production gate makes
the documented "easy local dev" mode false.

## Test dev and production-shaped preview

Run the same behavior suite twice:

1. `vite dev` against the source/module-runner path.
2. `vite build`, then `vite preview` against the bundled Worker in workerd.

Seed external-provider state offline where possible. For example, sign a test
webhook with a fixed local webhook secret and assert the real D1 effect instead
of provisioning a live payment account.

When Playwright manages the servers, run dev and preview sequentially if they
share the build directory or local D1 state. Set `inspectorPort: false` in the
Cloudflare plugin for automated runs that do not use the debugger, or assign
explicit distinct ports.
