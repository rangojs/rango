import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  waitForShellHydration,
  warmShellRequestToHit,
} from "./shell-request.js";

/**
 * Issue #1213: a `ppr` route whose `loader(Def, { ssr: false })` answers
 * notFound() after its shell was captured (the record was deleted
 * upstream). Past the shell's ttl the stale document HIT recaptures; the
 * recapture refuses and retires the key's stored entries, so the next
 * document is a live 404 and a client navigation no longer replays the
 * deleted record. Before, both kept serving the captured record, status 200,
 * for the whole SWR window.
 *
 * Fixture, in each app: `<path>/:id` with `ppr: { ttl: 1, swr: 300 }`, an
 * `ssr: false` loader that renders `record <id>` in `<prefix>-name` and
 * pushes the title `Record <id>`, a `notFoundBoundary()` rendering
 * `<prefix>-not-found`, and a GET `<deletePath>/:id` that deletes the
 * record.
 */
export interface PprLoaderNotFoundScenarioOptions {
  url: (pathname: string) => string;
  /** The route's path before its `:id` segment. */
  path: string;
  /** The delete endpoint's path before its `:id` segment. */
  deletePath: string;
  /** The fixture's test id prefix: `<prefix>-name`, `<prefix>-not-found`. */
  testIdPrefix: string;
}

const HTML_HEADERS = { Accept: "text/html" };

/**
 * A navigation after the retire: the tombstone (`no-segment-snapshot`), or no
 * entry once the tombstone's ttl (the route's 1s) ran out. Never a replay.
 */
const RETIRED_REPLAY = /^BYPASS; reason=(no-segment-snapshot|no-entry)$/;

/** A client navigation's partial request for `url`, from the site root. */
function requestPartial(
  request: APIRequestContext,
  url: string,
  from: string,
): ReturnType<APIRequestContext["get"]> {
  return request.get(`${url}?_rsc_partial=true&_rsc_segments=`, {
    headers: { "X-RSC-Router-Client-Path": from },
  });
}

export function runPprLoaderNotFoundTests(
  options: PprLoaderNotFoundScenarioOptions,
): void {
  test("a shell whose ssr: false loader now answers notFound() is retired: the document is a live 404 and a navigation does not replay it", async ({
    page,
  }) => {
    const id = randomUUID();
    const pathname = `${options.path}/${id}`;
    const url = options.url(pathname);
    const home = options.url("/");
    const name = `record ${id}`;

    const miss = await page.request.get(url, { headers: HTML_HEADERS });
    expect(miss.status()).toBe(200);
    expect(miss.headers()["x-rango-shell"]).toBe("MISS");
    expect(await miss.text()).toContain(name);
    await warmShellRequestToHit(page.request, url);
    const replay = await requestPartial(page.request, url, home);
    expect(replay.headers()["x-rango-ppr-replay"]).toBe("HIT; freshness=fresh");

    const deleted = await page.request.get(
      options.url(`${options.deletePath}/${id}`),
    );
    expect(deleted.ok()).toBe(true);
    // Past the shell's 1s ttl, inside its swr window.
    await page.waitForTimeout(1_500);

    // The first document past the ttl is the stale HIT, which recaptures;
    // the recapture retires the entry, and the next document renders live.
    await expect(async () => {
      const res = await page.request.get(url, { headers: HTML_HEADERS });
      expect(res.headers()["x-rango-shell"]).toBe("MISS");
      expect(res.status()).toBe(404);
      expect(await res.text()).not.toContain(name);
    }).toPass({ timeout: 15_000 });

    const nav = await requestPartial(page.request, url, home);
    expect(nav.headers()["x-rango-ppr-replay"]).toMatch(RETIRED_REPLAY);
    expect(await nav.text()).not.toContain(name);

    // In the browser: the navigation shows the not-found page, not the record.
    await page.goto(home);
    await waitForShellHydration(page);
    const partial = page.waitForResponse((response) => {
      const responseUrl = new URL(response.url());
      return (
        responseUrl.pathname === pathname &&
        responseUrl.searchParams.has("_rsc_partial")
      );
    });
    await page.evaluate((href) => {
      const link = document.createElement("a");
      link.href = href;
      document.body.append(link);
      link.click();
      link.remove();
    }, url);
    const response = await partial;
    expect(response.headers()["x-rango-ppr-replay"]).toMatch(RETIRED_REPLAY);
    await expect(page).toHaveURL(url);
    await expect(
      page.getByTestId(`${options.testIdPrefix}-not-found`),
    ).toBeVisible();
    await expect(page.getByTestId(`${options.testIdPrefix}-name`)).toHaveCount(
      0,
    );
    await expect(page).not.toHaveTitle(`Record ${id}`);
  });
}
