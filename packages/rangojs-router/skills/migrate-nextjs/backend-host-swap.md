# Backend and host swap audit

Use this audit when the Next-to-Rango migration also changes runtime, database,
or authentication provider. Route parity is not backend parity.

## Contents

- [Choose ownership](#choose-ownership)
- [Inventory database guarantees](#inventory-database-guarantees)
- [Replace authorization deliberately](#replace-authorization-deliberately)
- [Extract shared server services](#extract-shared-server-services)
- [Keep mutation side effects caller-owned](#keep-mutation-side-effects-caller-owned)
- [Audit runtime compatibility](#audit-runtime-compatibility)
- [Plan cutover and rollback](#plan-cutover-and-rollback)

## Choose ownership

Write down which system owns each concern before porting code:

| Concern                     | Existing owner          | Target owner                | Proof required                  |
| --------------------------- | ----------------------- | --------------------------- | ------------------------------- |
| session issuance/revocation | auth provider/app       | provider/app                | login, logout, expiry, rotation |
| tenant authorization        | RLS/service             | DAL/middleware/service      | cross-tenant denial tests       |
| invariants/atomicity        | DB function/trigger     | DB constraint/batch/service | concurrent mutation tests       |
| scheduled/background work   | host/provider           | Worker queue/cron/waitUntil | retry/idempotency test          |
| secrets                     | host env/provider vault | target secret store         | no client bundle leakage        |

Do not let a concern become "application code" without naming the module that
now enforces it.

## Inventory database guarantees

Search the source database for more than tables:

- row-level security policies and grants;
- functions/RPCs, triggers, generated columns, views, and extensions;
- unique/check/foreign-key constraints;
- transaction isolation, row locks, advisory locks, and sequences;
- storage objects, realtime subscriptions, and database webhooks.

For each item, choose one target:

1. preserve it in the target database;
2. replace it with a transaction/batch and application service;
3. reject the feature as unsupported and surface that product gap.

SQLite/D1 does not provide Postgres RLS, stored procedures, or row-level locking
semantics. A mechanical schema conversion is therefore incomplete even when
every table exists.

## Replace authorization deliberately

When RLS disappears, build an actor/tenant-scoped data-access layer. Accept an
actor and tenant scope at the repository boundary, verify membership/role, and
perform the data query through that scope. Avoid exporting an unrestricted DB
handle to page handlers.

Tests must prove denial, not only success:

- a user cannot read another tenant by guessing an ID;
- a member cannot perform an owner/admin mutation;
- a revoked session/token fails immediately enough for the product contract;
- background jobs and webhooks use an explicit service identity;
- every API/loader/action path reaches the same guard.

## Extract shared server services

Search server-only Next code for self-calls such as `fetch("/api/...")` or a
fully qualified request back to the same deployment. On Workers that is a real
subrequest with added latency and another authentication pass. Extract the
business operation into a plain service function instead:

```typescript
async function createProposal(db, scope, actor, input) {
  // validate, authorize, and mutate once
}
```

Let the HTTP response route and an MCP/OAuth/server caller each authenticate in
their own protocol, derive the same scope, and call that function in-process.
Keep the HTTP route as an auth-and-delegate boundary for external clients, not
as the unit of reuse inside the Worker.

## Keep mutation side effects caller-owned

Audit low-level mutations for bundled effects such as activity rows, audit
logs, cache invalidation, emails, and webhooks. A primitive written for a direct
edit can double-log when a reviewed proposal later composes the same primitive.
Prefer an atomic mutation with caller-selected effects, or expose an explicit
option such as `{ logActivity: false }`. Test composed flows for effect counts,
not only final row state.

## Audit runtime compatibility

For a Node-to-Workers move, search for:

- `node:*` modules, filesystem/process access, native addons, and TCP clients;
- SDKs whose default HTTP or crypto implementation is Node-only;
- synchronous crypto APIs and `Buffer`-specific formats;
- long-running/background work that exceeds `waitUntil`;
- response buffering that would destroy RSC streaming.

Prefer web standards (`fetch`, `Request`, `Response`, WebCrypto) and provider
bindings. Test the production bundle in `vite preview`; a successful TypeScript
check does not prove an SDK runs in workerd.

## Plan cutover and rollback

Define:

1. schema migration order and backfill scripts;
2. dual-read/write period, if any;
3. consistency checks and record counts;
4. auth/session migration or forced reauthentication;
5. DNS/traffic cutover;
6. rollback source of truth and the point after which rollback is unsafe.

Run behavior parity in both the old and new applications for protected reads,
mutations, OAuth/provider callbacks, billing/webhooks, and failure paths. A page
rendering successfully is not evidence that the backend contract survived.
