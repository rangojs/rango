"use client";

import { useState, useEffect } from "react";
import { useHref, Link } from "@rangojs/router/client";

interface HrefTestClientProps {
  isDetailPage?: boolean;
  // Initial values from server for hydration (avoids SSR/client mismatch)
  initialLocalIndex?: string;
  initialLocalDetail?: string;
  initialAbsoluteBlog?: string;
  initialPathBased?: string;
}

/**
 * Client component for testing useHref hook
 *
 * Pattern: Server component computes initial URLs using ctx.href() and passes them
 * as props. Client component uses these for initial render to avoid hydration mismatch,
 * then uses useHref() for subsequent dynamic navigation.
 *
 * This pattern works because:
 * - During SSR: props contain server-computed URLs
 * - During hydration: same props are used, no mismatch
 * - After hydration: useHref() can compute dynamic URLs (in effects/handlers)
 *
 * Important: useHref() returns a fallback function during SSR that just returns
 * the route name as-is. Only after NavigationProvider mounts does it have access
 * to the route map. Therefore:
 * - GOOD: use server-provided initial values for render
 * - GOOD: use useHref() in event handlers (onClick)
 * - GOOD: use useHref() in useEffect for dynamic updates
 * - BAD: use useHref() directly in render (causes hydration mismatch)
 */
export function HrefTestClient({
  isDetailPage,
  initialLocalIndex,
  initialLocalDetail,
  initialAbsoluteBlog,
  initialPathBased,
}: HrefTestClientProps) {
  // Use server-provided values for initial render
  // These are computed by ctx.href() on the server and passed as props
  const localIndex = initialLocalIndex ?? "/href";
  const localDetail = initialLocalDetail ?? (isDetailPage ? "/href/client-item" : "/href/from-client");
  const absoluteBlog = initialAbsoluteBlog ?? "/blog";
  const pathBased = initialPathBased ?? "/about";

  return (
    <div data-testid="client-href-test">
      <h3>Resolved URLs (server-provided)</h3>
      <ul>
        <li data-testid="client-local-index">
          Local index: <code>{localIndex}</code>
        </li>
        <li data-testid="client-local-detail">
          Local detail: <code>{localDetail}</code>
        </li>
        <li data-testid="client-absolute-blog">
          Absolute blog.index: <code>{absoluteBlog}</code>
        </li>
        <li data-testid="client-path-based">
          Path-based /about: <code>{pathBased}</code>
        </li>
      </ul>

      <h3>Client-rendered Links</h3>
      <div data-testid="client-links">
        <Link to={localIndex} data-testid="client-link-local-index">
          Local Index Link
        </Link>
        {" | "}
        <Link to={localDetail} data-testid="client-link-local-detail">
          Local Detail Link
        </Link>
        {" | "}
        <Link to={absoluteBlog} data-testid="client-link-absolute-blog">
          Blog Link
        </Link>
      </div>

      <h3>Dynamic useHref (post-hydration)</h3>
      <DynamicHrefDemo />
    </div>
  );
}

/**
 * This component demonstrates using useHref() after hydration.
 * It uses useState/useEffect to delay the href computation until after
 * the NavigationProvider has mounted and HrefContext is available.
 */
function DynamicHrefDemo() {
  const href = useHref();

  // State for dynamically computed URLs (only computed after hydration)
  const [dynamicUrls, setDynamicUrls] = useState<{
    index: string;
    blog: string;
  } | null>(null);

  // Compute URLs after hydration when HrefContext is available
  useEffect(() => {
    setDynamicUrls({
      index: href("index"),
      blog: href("blog.index"),
    });
  }, [href]);

  // During SSR and initial hydration, show placeholder
  // After effect runs, show actual computed URLs
  if (!dynamicUrls) {
    return (
      <div data-testid="dynamic-href-section">
        <p data-testid="dynamic-status">Computing...</p>
      </div>
    );
  }

  return (
    <div data-testid="dynamic-href-section">
      <p>
        Dynamic index: <code data-testid="dynamic-local-index">{dynamicUrls.index}</code>
      </p>
      <p>
        Dynamic blog: <code data-testid="dynamic-absolute-blog">{dynamicUrls.blog}</code>
      </p>
    </div>
  );
}
