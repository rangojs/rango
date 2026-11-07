import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * A stale entry's background refresh that answers notFound() retires the
 * entry: the next request runs the handler and the visitor gets the
 * not-found, not the deleted record's page. One that answers redirect() or
 * an error stores nothing and keeps serving the entry. Fixture:
 * refresh-outcome* in each app, mounted at "/refresh-outcome": each record,
 * named by `:k`, answers what /refresh-outcome/set/:k/:to last set, and every
 * cache there is fresh for 1 s and then stale for 60 s.
 *
 * - doc: the document cache, opted in by Cache-Control.
 * - route: route cache().
 * - loader: a loader's cache(), read by the handler.
 * - api: a response route's cache(); its not-found is a 404 RouterError.
 */
export interface RefreshOutcomeScenarioOptions {
  url: (pathname: string) => string;
}

type Writer = "doc" | "route" | "loader" | "api";
const WRITERS: Writer[] = ["doc", "route", "loader", "api"];

/** What the writer serves while the record exists. */
const PAGE: Record<Writer, string> = {
  doc: "record-page",
  route: "record-page",
  loader: "record-loaded:",
  api: "record-json",
};

export function runRefreshOutcomeTests(
  options: RefreshOutcomeScenarioOptions,
): void {
  async function setup(request: APIRequestContext, writer: Writer) {
    const k = `${writer}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const set = async (to: string) => {
      const res = await request.get(
        options.url(`/refresh-outcome/set/${k}/${to}`),
      );
      expect(res.status()).toBe(200);
    };
    const load = async () => {
      const res = await request.get(
        options.url(`/refresh-outcome/${writer}/${k}`),
        {
          headers: {
            Accept: writer === "api" ? "application/json" : "text/html",
          },
          maxRedirects: 0,
        },
      );
      const body = await res.text();
      return { status: res.status(), page: body.includes(PAGE[writer]) };
    };
    await set("page");
    expect(await load()).toEqual({ status: 200, page: true });
    // Past the 1 s ttl: the next read is stale.
    await new Promise((r) => setTimeout(r, 1_300));
    return { set, load };
  }

  for (const writer of WRITERS) {
    test(`${writer}: a refresh that answers notFound() retires the entry`, async ({
      request,
    }) => {
      const { set, load } = await setup(request, writer);
      await set("notFound");
      // The stale entry is served once more, and its refresh answers notFound().
      expect(await load()).toEqual({ status: 200, page: true });
      await expect
        .poll(load, { timeout: 10_000 })
        .toEqual({ status: 404, page: false });
      // A record that comes back is served and stored again.
      await set("page");
      await expect
        .poll(load, { timeout: 10_000 })
        .toEqual({ status: 200, page: true });
    });

    for (const outcome of ["redirect", "error"]) {
      test(`${writer}: a refresh that answers ${outcome} keeps serving the entry`, async ({
        request,
      }) => {
        const { set, load } = await setup(request, writer);
        await set(outcome);
        expect(await load()).toEqual({ status: 200, page: true });
        // Let the refresh land; the entry still serves.
        await new Promise((r) => setTimeout(r, 500));
        expect(await load()).toEqual({ status: 200, page: true });
        expect(await load()).toEqual({ status: 200, page: true });
      });
    }
  }
}
