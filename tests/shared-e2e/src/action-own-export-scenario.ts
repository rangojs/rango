import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Request,
} from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * An action id whose module key or export name is an inherited Object.prototype
 * member is answered exactly as a missing export of a real module is, for a JS
 * call and for a no-JS form post.
 */

export interface ActionOwnExportScenarioOptions {
  url: (pathname: string) => string;
  /** A page whose `submit` calls the "use server" module export `name`. */
  action: { path: string; submit: string; name: string };
}

interface ActionAnswer {
  status: number;
  /** The payload's `returnValue.ok`; undefined when it carries none. */
  ok: boolean | undefined;
}

/** Click `submit` on `url` and return the action request the page sent. */
async function sendAction(
  page: Page,
  url: string,
  submit: string,
): Promise<Request> {
  await page.goto(url);
  await waitForShellHydration(page);
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.headers()["rsc-action"] !== undefined,
  );
  await page.click(submit);
  return sent;
}

/** Replay `sent` under the action id `id`. */
async function replayAs(
  request: APIRequestContext,
  sent: Request,
  id: string,
): Promise<ActionAnswer> {
  const headers = sent.headers();
  const url = new URL(sent.url());
  url.searchParams.set("_rsc_action", id);
  const response = await request.post(url.href, {
    headers: {
      "rsc-action": id,
      "x-rsc-router-client-path": headers["x-rsc-router-client-path"]!,
      "content-type": headers["content-type"]!,
    },
    data: sent.postDataBuffer() ?? "",
  });
  const ok = (await response.text()).match(
    /"returnValue":\{"ok":(true|false)/,
  )?.[1];
  return {
    status: response.status(),
    ok: ok === undefined ? undefined : ok === "true",
  };
}

/** Post the no-JS form field `$ACTION_ID_<id>` to `url`; its status. */
async function postForm(
  request: APIRequestContext,
  url: string,
  id: string,
): Promise<number> {
  const response = await request.post(url, {
    multipart: { [`$ACTION_ID_${id}`]: "" },
  });
  return response.status();
}

export function runActionOwnExportTests(
  options: ActionOwnExportScenarioOptions,
): void {
  const { url, action } = options;

  test("an inherited key or name is answered like a missing export", async ({
    page,
    request,
  }) => {
    const sent = await sendAction(page, url(action.path), action.submit);
    const sentId = sent.headers()["rsc-action"]!;
    const key = sentId.slice(0, sentId.indexOf("#"));

    const [
      own,
      missing,
      inheritedName,
      inheritedKey,
      formMissing,
      formInherited,
    ] = await Promise.all([
      replayAs(request, sent, `${key}#${action.name}`),
      replayAs(request, sent, `${key}#missingExport`),
      replayAs(request, sent, `${key}#constructor`),
      replayAs(request, sent, "toString$$cache=#constructor"),
      postForm(request, url(action.path), `${key}#missingExport`),
      postForm(request, url(action.path), `${key}#constructor`),
    ]);
    expect(own).toEqual({ status: 200, ok: true });
    expect(missing.ok).toBe(false);
    expect({ inheritedName, inheritedKey, formInherited }).toEqual({
      inheritedName: missing,
      inheritedKey: missing,
      formInherited: formMissing,
    });
  });
}
