import type { MetaDescriptor } from "@rangojs/router";

interface AsyncChildMetaSetterProps {
  meta: (descriptor: MetaDescriptor) => void;
  title: string;
  description: string;
  delayMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Async RSC component that waits before calling meta.
 * Tests what happens when meta is set late in a streaming response.
 */
export async function AsyncChildMetaSetter({
  meta,
  title,
  description,
  delayMs,
}: AsyncChildMetaSetterProps) {
  // Simulate slow data fetch
  await sleep(delayMs);

  // Call meta after delay
  meta({ title });
  meta({ name: "description", content: description });
  meta({ property: "og:title", content: title });

  return (
    <div data-testid="async-child-meta-setter">
      <p data-testid="async-child-set-title">Set title after {delayMs}ms: {title}</p>
      <p data-testid="async-child-set-description">Set description: {description}</p>
    </div>
  );
}
