"use client";

import { useState } from "react";
import {
  Breadcrumbs,
  Link,
  Meta,
  useFetchLoader,
  useHandle,
  usePushHandle,
  useSearchParams,
} from "@rangojs/router/client";
import { PushHandleProjectLoader } from "./push-handle.loaders.js";

const BASE = "/push-handle";

/** The last Meta title, as a reader of the handle shows it. */
function useTitle(): string {
  const descriptors = useHandle(Meta) as readonly Record<string, unknown>[];
  const title = [...descriptors].reverse().find((d) => "title" in d)?.title;
  return typeof title === "string" ? title : "";
}

/** A reader of the title, in the layout or mounted with a pusher. */
export function PushHandleTitle({ testId }: { testId: string }) {
  return <p data-testid={testId}>{useTitle()}</p>;
}

/** The fixture's title and crumbs (the app's root layout pushes its own). */
export function PushHandleHead() {
  const crumbs = useHandle(Breadcrumbs).filter(
    (crumb) => crumb.href === BASE || crumb.href.startsWith(`${BASE}/`),
  );
  return (
    <header>
      <PushHandleTitle testId="ph-title" />
      <ol>
        {crumbs.map((crumb) => (
          <li key={crumb.href} data-testid="ph-crumb">
            {crumb.label}
          </li>
        ))}
      </ol>
      <Link to={`${BASE}/project`} data-testid="ph-to-project">
        Project
      </Link>
      <Link to={`${BASE}/chat?unread=3`} data-testid="ph-to-chat">
        Chat
      </Link>
    </header>
  );
}

/**
 * Reads a project with a fetch loader on demand and pushes its title and
 * crumb from the data: the server's crumb for the same href is replaced by
 * Breadcrumbs' dedupe, and the client's title wins as the later one.
 */
export function PushHandleProject() {
  const { data, load } = useFetchLoader(PushHandleProjectLoader);
  const pushTitle = usePushHandle(Meta);
  const pushCrumb = usePushHandle(Breadcrumbs);
  if (data) {
    pushTitle({ title: `PH ${data.name}` });
    pushCrumb({ label: data.name, href: `${BASE}/project` });
  }
  return (
    <section data-testid="ph-project">
      <p data-testid="ph-name">{data?.name ?? ""}</p>
      <button data-testid="ph-load" onClick={() => load().catch(() => {})}>
        Load
      </button>
    </section>
  );
}

function PushHandleUnread({ unread }: { unread: number }) {
  const push = usePushHandle(Meta);
  if (unread > 0) push({ title: `PH Chat (${unread})` });
  return <p data-testid="ph-unread">{unread}</p>;
}

/**
 * A live value the client changes (an unread count from `?unread=` and each
 * message): pushed as the title while the counter is mounted. A reader of
 * the title is mounted with it.
 */
export function PushHandleChat() {
  const [search] = useSearchParams();
  const [unread, setUnread] = useState(() => Number(search.get("unread") ?? 0));
  const [shown, setShown] = useState(true);
  return (
    <section data-testid="ph-chat">
      <PushHandleTitle testId="ph-own-title" />
      {shown && <PushHandleUnread unread={unread} />}
      <button data-testid="ph-message" onClick={() => setUnread((n) => n + 1)}>
        Message
      </button>
      <button data-testid="ph-hide" onClick={() => setShown((s) => !s)}>
        Hide
      </button>
    </section>
  );
}
