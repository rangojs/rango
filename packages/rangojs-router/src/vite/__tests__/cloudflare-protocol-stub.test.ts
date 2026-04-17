import { describe, expect, it } from "vitest";
import { createCloudflareProtocolStubPlugin } from "../plugins/cloudflare-protocol-stub.js";

type StubPlugin = ReturnType<typeof createCloudflareProtocolStubPlugin> & {
  resolveId: (id: string) => string | null;
  load: (id: string) => string | null;
};

function make(): StubPlugin {
  return createCloudflareProtocolStubPlugin() as StubPlugin;
}

describe("createCloudflareProtocolStubPlugin", () => {
  it("resolves cloudflare:* specifiers to a dedicated stub namespace", () => {
    const p = make();
    expect(p.resolveId("cloudflare:workers")).toBe(
      "\0cloudflare-stub:cloudflare:workers",
    );
    expect(p.resolveId("cloudflare:email")).toBe(
      "\0cloudflare-stub:cloudflare:email",
    );
  });

  it("uses a namespace that cannot collide with the generic virtual-stub plugin", () => {
    const p = make();
    const id = p.resolveId("cloudflare:workers")!;
    // Must NOT start with \0stub: which would make virtual-stub-plugin
    // opportunistically serve an empty default for cloudflare: imports.
    expect(id.startsWith("\0stub:")).toBe(false);
    expect(id.startsWith("\0cloudflare-stub:")).toBe(true);
  });

  it("does not touch unrelated specifiers", () => {
    const p = make();
    expect(p.resolveId("react")).toBeNull();
    expect(p.resolveId("virtual:rsc-router/foo")).toBeNull();
    expect(p.resolveId("./relative.js")).toBeNull();
  });

  it("emits cloudflare:workers stub with extendable base classes", () => {
    const p = make();
    const code = p.load("\0cloudflare-stub:cloudflare:workers")!;
    expect(code).toContain("export class DurableObject");
    expect(code).toContain("export class WorkerEntrypoint");
    expect(code).toContain("export class WorkflowEntrypoint");
    expect(code).toContain("export class RpcTarget");
    expect(code).toContain("export const env");
  });

  it("cloudflare:workers stub is valid ESM whose classes can be extended", async () => {
    const p = make();
    const code = p.load("\0cloudflare-stub:cloudflare:workers")!;
    const url = `data:text/javascript;base64,${Buffer.from(code).toString(
      "base64",
    )}`;
    const mod = (await import(url)) as {
      DurableObject: new (...args: unknown[]) => object;
      WorkerEntrypoint: new (...args: unknown[]) => object;
      env: object;
    };
    class MyDO extends mod.DurableObject {}
    class MyWE extends mod.WorkerEntrypoint {}
    expect(new MyDO()).toBeInstanceOf(mod.DurableObject);
    expect(new MyWE()).toBeInstanceOf(mod.WorkerEntrypoint);
    expect(mod.env).toEqual({});
  });

  it("throws a descriptive error for unsupported cloudflare:* modules", () => {
    const p = make();
    expect(() => p.load("\0cloudflare-stub:cloudflare:email")).toThrow(
      /Unsupported `cloudflare:email`/,
    );
    expect(() => p.load("\0cloudflare-stub:cloudflare:something-new")).toThrow(
      /cloudflare-protocol-stub\.ts/,
    );
  });

  it("returns null from load for non-stub ids", () => {
    const p = make();
    expect(p.load("react")).toBeNull();
    expect(p.load("\0stub:virtual:rsc-router/foo")).toBeNull();
  });
});
