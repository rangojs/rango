// "use cache" functions for the PPR snapshot pruning tests
// (shell-snapshot-prune.rsc-test.tsx), written with the directive and wrapped
// by rangoUseCacheTransform() (vitest.rsc.config.ts). Every value carries the
// source generation it was computed from, so a live re-read after the source
// moved on is visibly different from the value the capture pinned.
import type { ReactNode } from "react";

export const source: { generation: number } = { generation: 1 };

export async function getCatalog(slug: string): Promise<string[]> {
  "use cache";
  return [0, 1, 2].map((i) => `${slug}-item-${i}@g${source.generation}`);
}

export async function renderCatalog(slug: string): Promise<ReactNode> {
  "use cache";
  const items = await getCatalog(slug);
  return (
    <ul data-part="catalog">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export async function renderChrome(part: string): Promise<ReactNode> {
  "use cache";
  return <nav data-part={part}>{`${part}@g${source.generation}`}</nav>;
}

export async function getStamp(probe: string): Promise<string> {
  "use cache";
  return `${probe}-stamp@g${source.generation}`;
}
