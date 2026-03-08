"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";

export function StreamModeContent({
  loader,
}: {
  loader: LoaderDefinition<{ message: string }>;
}) {
  const {
    data: { message },
  } = useLoader(loader);
  return (
    <div data-testid="stream-mode-page">
      <p data-testid="stream-mode-message">{message}</p>
    </div>
  );
}
