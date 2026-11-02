"use client";

import { useLayoutEffect, useRef } from "react";
import { Link, useLoader } from "@rangojs/router/client";
import { LoaderRemountLoader } from "../loaders.js";

let mountSeq = 0;

/**
 * A reader of the registered LoaderRemountLoader with a refresh key, beside
 * its page's server-rendered marker (urls/key-refresh.tsx). `data-instance`
 * changes when the reader remounts; it is written without a render so the
 * reader's frames are the router's alone.
 */
export function LoaderRemountReader() {
  const { data, isLoading, error, load } = useLoader(LoaderRemountLoader, {
    key: "remount",
  });
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current!.dataset.instance = String(++mountSeq);
  }, []);
  return (
    <div ref={ref} data-testid="lr-reader">
      <span data-testid="lr-value">{`${data.page}:${data.run}`}</span>
      <span data-testid="lr-loading">{String(isLoading)}</span>
      <span data-testid="lr-error">{error?.message ?? ""}</span>
      <button data-testid="lr-refresh" onClick={() => load().catch(() => {})}>
        Refresh
      </button>
      <button
        data-testid="lr-slow-refresh"
        onClick={() => load({ params: { delay: "1500" } }).catch(() => {})}
      >
        Slow refresh
      </button>
    </div>
  );
}

export function LoaderRemountNav({ base }: { base: string }) {
  return (
    <nav>
      <Link to={`${base}/a`} data-testid="lr-link-a">
        A
      </Link>
      <Link to={`${base}/b`} data-testid="lr-link-b">
        B
      </Link>
      <Link to={`${base}/none`} data-testid="lr-link-none">
        None
      </Link>
      <Link to={`${base}/a?v=2`} data-testid="lr-link-a-next">
        A next
      </Link>
      <Link to={`${base}/vt?v=2`} data-testid="lr-link-vt-next">
        VT next
      </Link>
    </nav>
  );
}
