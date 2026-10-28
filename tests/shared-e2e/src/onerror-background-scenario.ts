import { expect, test } from "@playwright/test";

/**
 * onError's `background`: an error from work whose output goes only to a
 * cache reaches onError with `background: true` and `handledByBoundary:
 * false`, in the real runtime (workerd re-establishes the request ALS inside
 * a waitUntil task). Fixture: /errors/capture-fails/:k in each app, a ppr
 * page whose handler renders on its first run per :k and throws on every
 * later one, so the visitor's MISS renders and the shell capture after it
 * fails. Read back through /__test/last-error. Both apps call this from a
 * dev and a (production) describe.
 */

export interface OnErrorBackgroundScenarioOptions {
  url: (pathname: string) => string;
}

interface LoggedError {
  phase: string;
  message: string;
  handledByBoundary?: boolean;
  background?: boolean;
}

export function runOnErrorBackgroundTests(
  options: OnErrorBackgroundScenarioOptions,
): void {
  test("a shell capture's error reaches onError with background: true, not handled", async ({
    request,
  }) => {
    const k = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res = await request.get(options.url(`/errors/capture-fails/${k}`), {
      headers: { Accept: "text/html" },
    });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('data-testid="capture-fails-page"');

    const reportsForPage = async (): Promise<LoggedError[]> => {
      const log: LoggedError[] | null = await (
        await request.get(options.url("/__test/last-error"))
      ).json();
      return (log ?? []).filter((e) => e.message.includes(k));
    };
    // The capture runs after the response.
    await expect
      .poll(async () =>
        (await reportsForPage()).some((e) => e.phase === "handler"),
      )
      .toBe(true);
    const reports = await reportsForPage();
    expect(reports.find((e) => e.phase === "handler")).toMatchObject({
      background: true,
      handledByBoundary: false,
    });
    // The visitor's render reported nothing: every report is the capture's.
    expect(reports.map((e) => e.background)).not.toContain(undefined);
  });
}
