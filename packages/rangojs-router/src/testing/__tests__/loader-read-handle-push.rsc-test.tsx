/**
 * Userland (usePushHandle, case 14): a loader read (`_rsc_loader`, what
 * useFetchLoader().load(), refetch() and a refresh group send) renders no
 * segment, so a handle push from the loader's body, or from a loader it
 * awaits, has nowhere to land. The read answers its data; the push is
 * dropped, with one development warning per loader that points to
 * usePushHandle. serveShellRequest serves through the router's real handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createLoader, createRouter, urls } from "../../index.rsc.js";
import { createHandle } from "../../handle.js";

const Titles = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_loader_read_titles__",
);

const DepLoader = createLoader(async (ctx) => {
  ctx.use(Titles)("from the dependency");
  return "dep";
}, true);

const ProjectLoader = createLoader(async (ctx) => {
  const push = ctx.use(Titles);
  push("Project");
  push(Promise.reject(new Error("never read")));
  push.defer();
  const dep = await ctx.use(DepLoader);
  return { name: "Project", dep };
}, true);

const router = createRouter({}).routes(
  urls(({ path, loader }) => [
    path(
      "/project",
      () => <p>project page</p>,
      { name: "project" },
      () => [loader(ProjectLoader)],
    ),
  ]),
);

const read = (loaderId: string) =>
  serveShellRequest(
    router,
    `/project?_rsc_loader=${encodeURIComponent(loaderId)}`,
    { headers: { accept: "text/x-component" } },
  );

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await resetShellTestState();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.unstubAllEnvs();
});

const readWarnings = (): string[] =>
  warn.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((message: string) => message.includes("during a loader read"));

describe("a loader read whose body pushes a handle", () => {
  it("production: answers its data and drops the pushes, silently", async () => {
    const answer = await read(ProjectLoader.$$id);
    expect(answer.response.status).toBe(200);
    expect(answer.body).toContain('"name":"Project"');
    expect(answer.body).not.toContain("loaderError");
    expect(readWarnings()).toEqual([]);
  });

  it("development: answers its data, drops the pushes, and warns once per loader", async () => {
    // The rsc project runs as production; the warning is development-only.
    vi.stubEnv("NODE_ENV", "development");
    const first = await read(ProjectLoader.$$id);
    expect(first.response.status).toBe(200);
    expect(first.body).toContain('"name":"Project"');
    expect(first.body).toContain('"dep":"dep"');
    expect(first.body).not.toContain("loaderError");
    expect(first.body).not.toContain("from the dependency");
    expect(readWarnings()).toHaveLength(1);
    expect(readWarnings()[0]).toContain(ProjectLoader.$$id);
    expect(readWarnings()[0]).toContain("usePushHandle");

    const second = await read(ProjectLoader.$$id);
    expect(second.response.status).toBe(200);
    expect(readWarnings()).toHaveLength(1);
  });
});
