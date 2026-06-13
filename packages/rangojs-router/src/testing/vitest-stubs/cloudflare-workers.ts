// Stub for the `cloudflare:workers` runtime virtual, shipped for Cloudflare
// consumers (enable via `rangoTestAliases({ preset: "cloudflare" })`). A CF app's
// route tree commonly imports `cloudflare:workers` (e.g. `import { env } from
// "cloudflare:workers"`), which does not resolve in a bare Vitest process.
export const env: Record<string, unknown> = {};

export class DurableObject<Env = unknown> {
  constructor(
    public ctx: unknown,
    public env: Env,
  ) {}
}

export class WorkerEntrypoint<Env = unknown> {
  constructor(
    public ctx: unknown,
    public env: Env,
  ) {}
}

export class RpcTarget {}
