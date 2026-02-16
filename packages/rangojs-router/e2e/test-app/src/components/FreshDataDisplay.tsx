"use client";

import { useLoader, type LoaderDefinition } from "@rangojs/router/client";

interface FreshTimestampData {
  timestamp: number;
}

interface FreshDataDisplayProps {
  loader: LoaderDefinition<FreshTimestampData>;
}

export function FreshDataDisplay({ loader }: FreshDataDisplayProps) {
  const { data } = useLoader<FreshTimestampData>(loader);

  return (
    <div data-testid="fresh-data">
      <span data-testid="fresh-timestamp">{data.timestamp}</span>
    </div>
  );
}
