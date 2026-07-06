"use client";

import { type HTMLAttributes, useRef, useState } from "react";

function CopyGlyph({ copied }: { copied: boolean }) {
  return copied ? (
    <svg
      aria-hidden="true"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ) : (
    <svg
      aria-hidden="true"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <rect height="14" rx="2" width="14" x="8" y="8" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

/** MDX `pre` mapping: keeps the Shiki output and overlays a copy button. */
export function Pre(props: HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = ref.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable (e.g. insecure context) — no-op
    }
  }

  return (
    <div className="group relative">
      <pre {...props} ref={ref} />
      <button
        aria-label={copied ? "Copied" : "Copy code"}
        className="absolute top-2.5 right-2.5 rounded-md border border-gray-alpha-400 bg-background-100/70 p-1.5 text-gray-900 opacity-0 backdrop-blur transition hover:text-gray-1000 focus-visible:opacity-100 group-hover:opacity-100"
        onClick={copy}
        type="button"
      >
        <CopyGlyph copied={copied} />
      </button>
    </div>
  );
}
