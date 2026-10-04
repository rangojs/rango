// Dev/production parity helpers. `parityDescribe` registers a dev and a
// production describe from a single body, auto-generating the `(production)`
// title suffix so a suite can never drift into the wrong dev/prod bucket.
// `expectParity` runs one intent over the JS and no-JS paths and asserts the
// observable result is identical (progressive-enhancement parity).

import type { Expect, Page, TestType } from "@playwright/test";
import type { Fixture, FixtureOptions } from "./fixture.js";
import { DEFAULT_STATE_COOKIE_PREFIX } from "../../browser/cookie-name.js";
import { blockPrefetch, unblockPrefetch } from "./page-helpers.js";

export interface ParityDescribeOptions extends Partial<
  Omit<FixtureOptions, "mode">
> {}

export type ParityIntent =
  | { navigate: string }
  | { submit: { testId: string; data?: Record<string, string> } };

export interface ExpectParityOptions {
  /** data-testid values whose text content must match across JS and no-JS. */
  observe: string[];
  /** Base URL to resolve a relative `navigate` intent against. */
  baseURL?: string;
  /**
   * Escape hatch invoked after the intent is applied and before the snapshot is
   * taken, on BOTH the JS and the no-JS transports. When provided for a `submit`
   * intent it REPLACES the generic settle (the navigation/observed-change wait):
   * you take responsibility for awaiting the post-submit effect — for example,
   * awaiting a specific testid to reach a known value, or a network response the
   * page does not reflect in the observed testids. Receives the page for the
   * transport being snapshotted.
   */
  waitFor?: (page: Page) => Promise<void>;
  /**
   * Cookie NAMES to exclude from the JS-vs-no-JS jar comparison, matched exactly
   * (string) or by pattern (RegExp). The rango state cookie (default prefix
   * `rango-state`) is ALWAYS excluded — it is written/rotated only by the client
   * runtime, so it is JS-only by design and never appears in the no-JS jar. Use
   * this for a custom `stateCookiePrefix` (e.g. `[/^myapp-state_/]`) or any other
   * volatile/JS-only cookie (analytics, CSRF) that should not break parity.
   */
  ignoreCookies?: ReadonlyArray<string | RegExp>;
}

export interface Parity {
  /**
   * Register a dev describe (title `name`) and a production describe (title
   * `` `${name} (production)` ``) from one body. The `(production)` suffix is
   * generated here, so the production suite always lands in the production
   * bucket regardless of how the consumer names things.
   *
   * `options.root` is required, either here or as `defaultRoot` passed to the
   * factory.
   */
  parityDescribe: (
    name: string,
    body: (f: Fixture) => void,
    options?: ParityDescribeOptions,
  ) => void;
  /**
   * Run a single `intent` over both the JS path (the given `page`) and a
   * fresh no-JS context, then assert the observed snapshots are equal.
   *
   * PE parity only holds if the consumer's submit target is a real `<form>`
   * that progressively enhances: with JS disabled the browser performs a native
   * form POST, and the server must produce the same observable result the
   * enhanced client path produces. Navigation intents must be plain links/URLs
   * that resolve server-side without JS.
   *
   * For a `submit` intent the helper waits for the action's observable effect
   * before snapshotting: either a navigation away from the form, or a change to
   * one of the `observe` testids from its pre-submit value (then a brief
   * stability confirm). A submit that produces neither within ~5s throws —
   * include the testid that changes in `observe`, or pass `waitFor` to express
   * the precise wait. This prevents snapshotting the pre-submit DOM when the
   * action is slow.
   *
   * The snapshot is intentionally strict: it compares the text of every
   * observed `data-testid`, the resulting `page.url()`, and the cookies visible
   * via `document.cookie`. No ephemeral-value normalization is applied in v1;
   * if a consumer's page renders nondeterministic values, exclude that testid
   * from `observe`.
   *
   * LIMITATION: cookie parity is read from `document.cookie`, which by design
   * EXCLUDES HttpOnly cookies. Session/auth cookies (the typical HttpOnly case)
   * are therefore NOT compared — a PE/JS divergence in an HttpOnly cookie will
   * not be caught here. Assert on those via `read_network_requests` / response
   * Set-Cookie headers in a dedicated test, not expectParity.
   *
   * Submit-intent requirements (the `submit` path runs the intent TWICE against
   * the same server, and compares whole cookie jars from two contexts):
   * - DOUBLE EXECUTION: the JS path submits, then the no-JS pass reloads the
   *   same `originUrl` in a fresh context and submits AGAIN. Both hit the one
   *   running server, so a non-idempotent action runs twice. The no-JS snapshot
   *   then observes BOTH mutations unless the mutated state is per-session /
   *   per-context — e.g. an add-to-cart count only reaches the same value on
   *   both transports if the cart is session-scoped (the JS context and the
   *   fresh no-JS context are distinct sessions). A globally-shared counter
   *   would read N after the JS submit and N+1 after the no-JS submit and
   *   false-mismatch. Make the action's observable state session/context-scoped,
   *   or assert the submit path some other way.
   * - COOKIE JAR vs DELTA: the cookie check compares the WHOLE `document.cookie`
   *   of two different contexts. The JS context carries every cookie accumulated
   *   before the intent (consent, analytics, prior navigations); the fresh no-JS
   *   context starts empty. Unrelated pre-existing cookies therefore false-
   *   mismatch — expectParity compares jars, not the per-submit cookie delta.
   *   Keep the JS context's pre-intent cookie state minimal, or assert the
   *   specific Set-Cookie elsewhere.
   * - RANGO STATE COOKIE: the rango state cookie (default prefix `rango-state`)
   *   is written/rotated only by the client runtime, so it is JS-only by design
   *   and would always diverge — it is excluded from the comparison
   *   automatically. A custom `stateCookiePrefix` (or any other volatile/JS-only
   *   cookie) is excluded via `opts.ignoreCookies`.
   */
  expectParity: (
    page: Page,
    intent: ParityIntent,
    opts: ExpectParityOptions,
  ) => Promise<void>;
}

interface ParitySnapshot {
  testIds: Record<string, string | null>;
  url: string;
  cookies: string;
}

async function applyIntent(
  page: Page,
  intent: ParityIntent,
  baseURL?: string,
): Promise<void> {
  if ("navigate" in intent) {
    const target = baseURL
      ? new URL(intent.navigate, baseURL).href
      : intent.navigate;
    await page.goto(target, { waitUntil: "networkidle" });
    return;
  }
  const form = page.locator(`[data-testid="${intent.submit.testId}"]`);
  if (intent.submit.data) {
    for (const [name, value] of Object.entries(intent.submit.data)) {
      await form.locator(`[name="${name}"]`).fill(value);
    }
  }
  // No post-click wait here: a native (no-JS) submit triggers a top-level
  // navigation while an enhanced (JS) submit usually updates the DOM in place
  // with no navigation, so a navigation-based wait races the click and can
  // resolve before the effect lands. The post-action settle in expectParity is
  // DOM-driven (settleSubmit) and works whether or not a navigation occurs.
  await form
    .locator('button[type="submit"], input[type="submit"]')
    .first()
    .click();
}

// Concatenate the observed testids' text into a single comparable string used
// to detect post-submit change/stability. "\0" marks an absent testid and
// "\x01" joins parts so two distinct testid layouts can never concatenate to the
// same string. Written as escaped control chars (not literal bytes) for source
// readability.
async function readObserved(page: Page, observe: string[]): Promise<string> {
  const parts: string[] = [];
  for (const id of observe) {
    const text = await page
      .locator(`[data-testid="${id}"]`)
      .first()
      .textContent()
      .catch(() => null);
    parts.push(`${id}=${text ?? "\0"}`);
  }
  return parts.join("\x01");
}

// Settle a submit's observable effect. An enhanced (JS) submit mutates the DOM
// in place with no navigation, while a native (no-JS) submit navigates — so we
// wait for EITHER a navigation away from the form OR a change in the observed
// testids from their pre-submit `baseline`, then confirm the new state is stable
// across two reads. Requiring an observed change (not just stability) closes the
// gap where a slow action leaves the pre-submit DOM momentarily stable and gets
// snapshotted as the "result". A submit that produces neither a navigation nor
// an observed change within the ceiling throws, rather than silently capturing
// the pre-submit state — pass `waitFor` when the observed set cannot capture the
// effect.
async function settleSubmit(
  page: Page,
  observe: string[],
  baseline: string,
  originUrl: string,
): Promise<void> {
  const pollIntervalMs = 50;
  const maxAttempts = 100; // ~5s ceiling
  let landed = false;
  let last = baseline;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await page.waitForTimeout(pollIntervalMs);
    const current = await readObserved(page, observe);
    if (!landed) {
      if (page.url() !== originUrl || current !== baseline) {
        landed = true;
        last = current;
      }
      continue;
    }
    if (current === last) return;
    last = current;
  }
  if (!landed) {
    throw new Error(
      `expectParity: the submit intent produced no observable effect within 5s — ` +
        `no navigation away from "${originUrl}" and no change to the observed ` +
        `testids [${observe.join(", ")}]. Include the testid that changes in ` +
        `\`observe\`, or pass \`waitFor\` to express the precise post-submit wait.`,
    );
  }
  // Landed but never stabilized within the ceiling: warn (so a slow/flaky action
  // is visible rather than silently snapshotting a mid-flight DOM), then fall
  // through and snapshot the last-read state — the parity equality assertion
  // still surfaces any JS-vs-no-JS mismatch. A throw here would risk failing a
  // slow-but-correct submit, so this stays a warning.
  console.warn(
    `expectParity: the observed testids [${observe.join(", ")}] did not stabilize ` +
      `within 5s; snapshotting the last-read state. If this is flaky, pass ` +
      `\`waitFor\` to express the precise post-submit wait.`,
  );
}

async function snapshot(
  page: Page,
  observe: string[],
): Promise<ParitySnapshot> {
  const testIds: Record<string, string | null> = {};
  for (const id of observe) {
    // Match readObserved: .first() (a testid may repeat) + .catch (a missing
    // testid yields null, not an unhandled rejection).
    testIds[id] = await page
      .locator(`[data-testid="${id}"]`)
      .first()
      .textContent()
      .catch(() => null);
  }
  return {
    testIds,
    url: page.url(),
    cookies: await page.evaluate(() => document.cookie),
  };
}

// Reduce a `document.cookie` string to the cookies that should match across the
// JS and no-JS transports. The rango state cookie (default prefix `rango-state`)
// is always dropped — it is written/rotated only by the client runtime, so it
// exists in the JS jar but never the no-JS one. `ignore` drops additional names
// (a custom stateCookiePrefix, or other JS-only/volatile cookies) by exact
// string or RegExp match. Returns a normalized, sorted `name=value; ...` string.
function parityCookies(
  cookieString: string,
  ignore: ReadonlyArray<string | RegExp>,
): string {
  const isIgnored = (name: string): boolean => {
    if (name.startsWith(DEFAULT_STATE_COOKIE_PREFIX)) return true;
    return ignore.some((m) =>
      typeof m === "string" ? m === name : m.test(name),
    );
  };
  return cookieString
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .filter((c) => {
      const eq = c.indexOf("=");
      const name = eq === -1 ? c : c.slice(0, eq);
      return !isIgnored(name);
    })
    .sort()
    .join("; ");
}

export function createParity({
  test: _test,
  expect,
  useFixture,
  defaultRoot,
}: {
  test: TestType<any, any>;
  expect: Expect;
  useFixture: (options: FixtureOptions) => Fixture;
  defaultRoot?: string;
}): Parity {
  function parityDescribe(
    name: string,
    body: (f: Fixture) => void,
    options?: ParityDescribeOptions,
  ): void {
    const root = options?.root ?? defaultRoot;
    if (!root) {
      throw new Error(
        `parityDescribe("${name}") requires a root: pass options.root or set defaultRoot in createRangoE2E.`,
      );
    }
    _test.describe(name, () => {
      const f = useFixture({ ...options, root, mode: "dev" });
      body(f);
    });
    _test.describe(`${name} (production)`, () => {
      const f = useFixture({ ...options, root, mode: "build" });
      body(f);
    });
  }

  async function expectParity(
    page: Page,
    intent: ParityIntent,
    opts: ExpectParityOptions,
  ): Promise<void> {
    // For a submit intent, the form lives on the page the caller already
    // navigated to; capture that origin URL before the JS submit changes it so
    // the no-JS path can load the same form, and so settleSubmit can detect a
    // navigation away from it.
    const originUrl = page.url();

    // Exclude speculative prefetch traffic from the parity window. Links
    // prefetch by default in production unless the router opts out, and a
    // prefetched route's middleware/loader side effects
    // (Set-Cookie, session state) land in the JS jar only — a no-JS context
    // cannot prefetch, so that traffic would diverge the jars on requests the
    // intent never caused. Aborted prefetches are benign by design (evicted,
    // never adopted), so the intent's real navigation always fetches live.
    await blockPrefetch(page);

    // Settle the intent's observable effect before snapshotting. A `navigate`
    // intent already awaited its navigation in applyIntent (page.goto), so only
    // `submit` needs the DOM-driven settle, and only when no `waitFor` override
    // is given. waitFor, when present, replaces the generic settle for submit
    // and runs after the navigation for navigate — on whichever page is about to
    // be snapshotted.
    const settle = async (
      target: Page,
      baseline: string,
      origin: string,
    ): Promise<void> => {
      if ("submit" in intent) {
        if (opts.waitFor) {
          await opts.waitFor(target);
        } else {
          await settleSubmit(target, opts.observe, baseline, origin);
        }
      } else if (opts.waitFor) {
        await opts.waitFor(target);
      }
    };

    // JS path: the given page (JS enabled by default). Read the pre-submit
    // baseline before applying the intent so the settle can require a change.
    const jsBaseline =
      "submit" in intent ? await readObserved(page, opts.observe) : "";
    await applyIntent(page, intent, opts.baseURL);
    await settle(page, jsBaseline, originUrl);
    const jsSnapshot = await snapshot(page, opts.observe);

    // No-JS path: a fresh context with scripting disabled.
    const browser = page.context().browser()!;
    const noJsContext = await browser.newContext({ javaScriptEnabled: false });
    try {
      const noJsPage = await noJsContext.newPage();
      if (!("navigate" in intent)) {
        // A submit intent needs the form rendered first; start from the same
        // URL the JS path observed the form on.
        await noJsPage.goto(originUrl, { waitUntil: "networkidle" });
      }
      const noJsOrigin = noJsPage.url();
      const noJsBaseline =
        "submit" in intent ? await readObserved(noJsPage, opts.observe) : "";
      await applyIntent(noJsPage, intent, opts.baseURL);
      await settle(noJsPage, noJsBaseline, noJsOrigin);
      const noJsSnapshot = await snapshot(noJsPage, opts.observe);

      expect(noJsSnapshot.testIds).toEqual(jsSnapshot.testIds);
      // Compare pathname + search + hash, not pathname alone: a JS vs no-JS flow
      // that diverges only in query/hash (e.g. /search?q=a vs /search?q=b) would
      // otherwise pass.
      const locationOf = (u: string): string => {
        const url = new URL(u);
        return url.pathname + url.search + url.hash;
      };
      expect(locationOf(noJsSnapshot.url)).toEqual(locationOf(jsSnapshot.url));
      const ignore = opts.ignoreCookies ?? [];
      expect(parityCookies(noJsSnapshot.cookies, ignore)).toEqual(
        parityCookies(jsSnapshot.cookies, ignore),
      );
    } finally {
      await noJsContext.close();
      // Restore the caller's page: the prefetch guard is scoped to the parity
      // window, not the rest of the test.
      await unblockPrefetch(page);
    }
  }

  return { parityDescribe, expectParity };
}
