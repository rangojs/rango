import { describe, expect, it, vi } from "vitest";
import { resolve } from "../plugins/cloudflare-protocol-loader-hook.mjs";

describe("cloudflare-protocol-loader-hook", () => {
  it("short-circuits cloudflare:workers to a data: URL stub", async () => {
    const next = vi.fn(() => {
      throw new Error(
        "nextResolve should not be called for cloudflare:workers",
      );
    });
    const result = await resolve("cloudflare:workers", {}, next);
    expect(result.shortCircuit).toBe(true);
    expect(result.format).toBe("module");
    expect(result.url).toMatch(/^data:text\/javascript;base64,/);
    expect(next).not.toHaveBeenCalled();
  });

  it("the data URL payload is executable ESM with extendable base classes", async () => {
    const result = await resolve("cloudflare:workers", {}, () => {
      throw new Error("should not fall through");
    });
    const mod = (await import(result.url)) as {
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

  it("throws for unsupported cloudflare:* specifiers", async () => {
    const next = vi.fn();
    await expect(resolve("cloudflare:email", {}, next)).rejects.toThrow(
      /Unsupported `cloudflare:email`/,
    );
    await expect(resolve("cloudflare:sockets", {}, next)).rejects.toThrow(
      /cloudflare-protocol-loader-hook\.mjs/,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("delegates unrelated specifiers to nextResolve", async () => {
    const sentinel = {
      shortCircuit: true,
      url: "file:///foo.js",
      format: "module",
    };
    const next = vi.fn().mockResolvedValue(sentinel);
    const result = await resolve(
      "react",
      { parentURL: "file:///app.js" },
      next,
    );
    expect(result).toBe(sentinel);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith("react", { parentURL: "file:///app.js" });
  });

  it("passes bare non-cloudflare specifiers starting with 'cloud' through", async () => {
    const next = vi.fn().mockResolvedValue({});
    await resolve("cloudinary", {}, next);
    await resolve("cloudflareish", {}, next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
