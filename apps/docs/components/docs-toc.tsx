"use client";

import { useEffect, useState } from "react";

import type { TocEntry } from "../src/content";

// Headings whose top edge is above this viewport line count as "reached":
// the sticky navbar (h-14) plus the article's own scroll-margin.
const ACTIVATION_LINE_PX = 96;

function findActiveId(entries: TocEntry[]): string | undefined {
  const doc = document.documentElement;
  const atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
  let active: string | undefined;
  for (const entry of entries) {
    const el = document.getElementById(entry.id);
    if (!el) continue;
    if (atBottom) active = entry.id;
    else if (el.getBoundingClientRect().top <= ACTIVATION_LINE_PX)
      active = entry.id;
    else break;
  }
  return active ?? entries[0]?.id;
}

/**
 * "On this page" list with the current section highlighted. The active
 * heading is derived from scroll position (last heading above the activation
 * line; last entry once the page bottom is reached) rather than an
 * IntersectionObserver so short trailing sections still get selected.
 */
export function DocsToc({ toc }: { toc: TocEntry[] }) {
  const [activeId, setActiveId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setActiveId(findActiveId(toc));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [toc]);

  return (
    <div className="relative ms-3.5 flex flex-col gap-0.5 before:absolute before:inset-y-0 before:-left-3.25 before:w-px before:bg-border">
      {toc.map((entry) => (
        <a
          className="relative py-1 text-[.8125rem] leading-4.5 text-muted-foreground transition-colors before:absolute before:inset-y-px before:-left-3.25 before:w-px before:rounded-full hover:text-foreground data-[active=true]:text-foreground data-[active=true]:before:w-0.5 data-[active=true]:before:bg-primary data-[depth=3]:ps-3.5 data-[depth=4]:ps-5.5"
          data-active={entry.id === activeId}
          data-depth={entry.depth}
          href={`#${entry.id}`}
          key={entry.id}
        >
          {entry.text}
        </a>
      ))}
    </div>
  );
}
