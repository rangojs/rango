"use client";

import { useHandle } from "@rangojs/router/client";
import { CacheInterceptLayoutStamp } from "./cache-intercept-crumbs.defs.js";

/** The layout's render stamp as its handle value shows it. */
export function CacheInterceptStampCrumb() {
  const stamps = useHandle(CacheInterceptLayoutStamp);
  return <p data-testid="cic-layout-stamp">{stamps.join(",")}</p>;
}
