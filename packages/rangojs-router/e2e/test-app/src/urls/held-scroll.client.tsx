"use client";

import { useState, type ReactNode } from "react";
import { Link } from "@rangojs/router/client";
import { heldScrollAction } from "./held-scroll.actions.js";

/**
 * Links that stay on /held-scroll, and a button that runs an action. The
 * count shows once the action has settled, by which time the client cache is
 * marked stale.
 */
export function HeldScrollNav(): ReactNode {
  const [actions, setActions] = useState(0);
  return (
    <nav
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        background: "white",
      }}
    >
      <Link to="/held-scroll" data-testid="held-scroll-self">
        This page
      </Link>
      <Link to="/held-scroll?q=1" data-testid="held-scroll-search">
        Search
      </Link>
      <Link to="/held-scroll?q=2" scroll={false} data-testid="held-scroll-keep">
        Search, keep scroll
      </Link>
      <Link
        to="/held-scroll?q=3#held-scroll-target"
        data-testid="held-scroll-hash"
      >
        Search, hash target
      </Link>
      <button
        type="button"
        data-testid="held-scroll-action"
        onClick={async () => {
          await heldScrollAction();
          setActions((count) => count + 1);
        }}
      >
        Action
      </button>
      <span data-testid="held-scroll-actions">{actions}</span>
    </nav>
  );
}
