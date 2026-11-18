import { expect, test, type Page } from "@playwright/test";

/**
 * Client components push handle values (usePushHandle): a title and a crumb
 * from data a fetch loader brought, a live value the client changes, a
 * clientUrls page whose loader pushes the title and whose component pushes a
 * draft over it. The values show with the render that pushed them and leave
 * with the component that pushed them.
 *
 * Fixture in each app: a layout under `base` that pushes the crumb "PH" and
 * renders the fixture's Meta title (ph-title) and crumbs (ph-crumb), with
 * links to the project (ph-to-project) and to the chat with three unread
 * (ph-to-chat). `${base}/project` pushes the title "PH Project" and the crumb
 * "Project" on the server; its component loads an unregistered fetch loader
 * on ph-load (`Project <n>`, shown in ph-name) and pushes the title
 * `PH Project <n>` and a crumb for the same href. `${base}/chat` pushes the
 * title "PH Chat" on the server; its component pushes `PH Chat (<unread>)`
 * while the count (from `?unread=`, ph-message adds one) is above zero and
 * the counter is mounted (ph-hide toggles it), and mounts a title reader
 * (ph-own-title) with it. `${groupBase}` is a clientUrls group page whose
 * loader pushes `PHG Group <n>` (phg-name, phg-load reads it again) and whose
 * component pushes `PHG Draft` while a draft is set (phg-rename, phg-clear),
 * with a title reader (phg-title). `${base}/held/<id>` is a transition() page
 * whose server pushes `PH Held <id>` and whose component pushes
 * `PH Held <id> (<n>)` once ph-bump was clicked n times (id in ph-held-id);
 * ph-to-slow goes to `${base}/held/slow`, which the server answers seconds
 * late. `${base}/stream` pushes the title "PH Stream" on the server; its
 * ph-stream-load reads a fetch that answers 1.5 s late and pushes the
 * promise of `PH Stream Feed <n>`.
 */

export interface PushHandleScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  expectNoPageError: (page: Page) => Disposable;
  /** Path prefix of the urls() fixture, e.g. "/push-handle". */
  base: string;
  /** Mount path of the clientUrls() fixture, e.g. "/push-handle-group". */
  groupBase: string;
}

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Frame {
  chat: boolean;
  project: boolean;
  held: string;
  title: string;
  own: string;
  doc: string;
}

/**
 * Record what each animation frame is about to paint until stopFrames():
 * whether the chat or the project page is on screen and what the title
 * readers show. A requestAnimationFrame callback runs before the frame's
 * paint, after every task that ran since the last one.
 */
async function startFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __phFrames: Frame[]; __phStop: boolean };
    const text = (id: string) =>
      document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
    w.__phFrames = [];
    w.__phStop = false;
    const tick = () => {
      w.__phFrames.push({
        chat: document.querySelector('[data-testid="ph-chat"]') !== null,
        project: document.querySelector('[data-testid="ph-project"]') !== null,
        held: text("ph-held-id"),
        title: text("ph-title"),
        own: text("ph-own-title"),
        doc: document.title,
      });
      if (!w.__phStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __phFrames: Frame[]; __phStop: boolean };
    w.__phStop = true;
    return w.__phFrames;
  });
}

/** The project's name once ph-name shows one other than `previous`. */
async function nameAfter(page: Page, previous: string): Promise<string> {
  const handle = await page.waitForFunction((prev) => {
    const text =
      document.querySelector('[data-testid="ph-name"]')?.textContent ?? "";
    return /^Project \d+$/.test(text) && text !== prev ? text : null;
  }, previous);
  return (await handle.jsonValue()) as string;
}

async function expectTitle(page: Page, title: string): Promise<void> {
  await expect(testId(page, "ph-title")).toHaveText(title);
  await expect(page).toHaveTitle(new RegExp(escape(title)));
}

export function runPushHandleTests(options: PushHandleScenarioOptions): void {
  const { url, waitForHydration, expectNoPageError, base, groupBase } = options;

  test("a fetch loader's data pushed from the component sets the title and crumb; each load replaces them", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(url(`${base}/project`));
    await waitForHydration(page);
    await expectTitle(page, "PH Project");
    await expect(testId(page, "ph-crumb")).toHaveText(["PH", "Project"]);

    await testId(page, "ph-load").click();
    const first = await nameAfter(page, "");
    await expectTitle(page, `PH ${first}`);
    await expect(testId(page, "ph-crumb")).toHaveText(["PH", first]);

    // Again: the component's values follow its data, never add to them.
    await testId(page, "ph-load").click();
    const second = await nameAfter(page, first);
    await expectTitle(page, `PH ${second}`);
    await expect(testId(page, "ph-crumb")).toHaveText(["PH", second]);
  });

  test("a live value the client changes sets the title; unmounting the pusher brings back the server's", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(url(`${base}/chat`));
    await waitForHydration(page);
    await expectTitle(page, "PH Chat");

    await testId(page, "ph-message").click();
    await expectTitle(page, "PH Chat (1)");
    await expect(testId(page, "ph-own-title")).toHaveText("PH Chat (1)");
    await testId(page, "ph-message").click();
    await expectTitle(page, "PH Chat (2)");

    await testId(page, "ph-hide").click();
    await expectTitle(page, "PH Chat");
    await testId(page, "ph-hide").click();
    await expectTitle(page, "PH Chat (2)");
  });

  test("a navigation that mounts a pusher and a reader: no frame shows the page without the client's title", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(url(`${base}/project`));
    await waitForHydration(page);
    await expectTitle(page, "PH Project");

    await startFrames(page);
    await testId(page, "ph-to-chat").click();
    await expectTitle(page, "PH Chat (3)");
    await expect(testId(page, "ph-own-title")).toHaveText("PH Chat (3)");
    // Two more frames, so the frame after the commit is recorded too.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const frames = await stopFrames(page);

    const chatFrames = frames.filter((f) => f.chat);
    expect(chatFrames.length).toBeGreaterThan(0);
    expect(
      chatFrames.filter(
        (f) =>
          f.title !== "PH Chat (3)" ||
          f.own !== "PH Chat (3)" ||
          !f.doc.includes("PH Chat (3)"),
      ),
    ).toEqual([]);
  });

  test("navigating away removes the old page's client value in the new page's commit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(url(`${base}/chat?unread=3`));
    await waitForHydration(page);
    // The document is the server's ("PH Chat"); the client's value applies
    // once the page has hydrated.
    await expectTitle(page, "PH Chat (3)");

    await startFrames(page);
    await testId(page, "ph-to-project").click();
    await expectTitle(page, "PH Project");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const frames = await stopFrames(page);

    const projectFrames = frames.filter((f) => f.project);
    expect(projectFrames.length).toBeGreaterThan(0);
    expect(
      projectFrames.filter(
        (f) => f.title !== "PH Project" || f.doc.includes("PH Chat"),
      ),
    ).toEqual([]);
  });

  test("a view transition holds the next page: a push on the page on screen shows at once, and the next page's title comes with it", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(url(`${base}/held/1`));
    await waitForHydration(page);
    await expectTitle(page, "PH Held 1");

    await startFrames(page);
    await testId(page, "ph-to-slow").click();
    await testId(page, "ph-bump").click();
    // React holds the slow page: the page on screen takes its own push, over
    // its own server title.
    await expectTitle(page, "PH Held 1 (1)");
    await expect(testId(page, "ph-held-id")).toHaveText("1");

    await expect(testId(page, "ph-held-id")).toHaveText("slow", {
      timeout: 15000,
    });
    await expectTitle(page, "PH Held slow");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const frames = await stopFrames(page);

    // The held page's title showed while it was held, and the next page's
    // server title never showed over the page being left.
    expect(
      frames.some((f) => f.held === "1" && f.title === "PH Held 1 (1)"),
    ).toBe(true);
    expect(
      frames.filter((f) => f.held === "1" && f.title.includes("slow")),
    ).toEqual([]);
    // The page that committed never shows the left page's client value
    // once its own title has shown.
    const shown = frames.findIndex(
      (f) => f.held === "slow" && f.title === "PH Held slow",
    );
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(
      frames.slice(shown).filter((f) => f.title !== "PH Held slow"),
    ).toEqual([]);
  });

  test("a promise from a fetch pushed as the title: the server's title stays until it resolves, then the fetched one shows", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(url(`${base}/stream`));
    await waitForHydration(page);
    await expectTitle(page, "PH Stream");

    await startFrames(page);
    await testId(page, "ph-stream-load").click();
    // Pending: readers keep the server's title, never a blank.
    await expect(testId(page, "ph-title")).toHaveText("PH Stream");
    await expect(testId(page, "ph-title")).toHaveText(/^PH Stream Feed \d+$/, {
      timeout: 10000,
    });
    const fetched = (await testId(page, "ph-title").textContent()) ?? "";
    await expect(page).toHaveTitle(new RegExp(escape(fetched)));
    const frames = await stopFrames(page);
    expect(
      frames.filter((f) => f.title !== "PH Stream" && f.title !== fetched),
    ).toEqual([]);
  });

  test("a clientUrls page: the loader's title, then a draft the component pushes over it, which a new read keeps", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(url(groupBase));
    await waitForHydration(page);
    const name = (await testId(page, "phg-name").textContent()) ?? "";
    expect(name).toMatch(/^Group \d+$/);
    await expect(testId(page, "phg-title")).toHaveText(`PHG ${name}`);
    await expect(page).toHaveTitle(new RegExp(escape(`PHG ${name}`)));

    await testId(page, "phg-rename").click();
    await expect(testId(page, "phg-title")).toHaveText("PHG Draft");
    await expect(page).toHaveTitle(/PHG Draft/);

    // A read of the loader brings its new title; the draft stays after it.
    await testId(page, "phg-load").click();
    await expect(testId(page, "phg-name")).not.toHaveText(name);
    const next = (await testId(page, "phg-name").textContent()) ?? "";
    await expect(testId(page, "phg-title")).toHaveText("PHG Draft");

    await testId(page, "phg-clear").click();
    await expect(testId(page, "phg-title")).toHaveText(`PHG ${next}`);
    await expect(page).toHaveTitle(new RegExp(escape(`PHG ${next}`)));
  });
}
