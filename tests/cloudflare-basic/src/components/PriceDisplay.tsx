"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router/client";

type PriceData = {
  prices: Record<string, number>;
  fetchedAt: number;
};

export function PriceDisplay({
  loader,
  testId,
}: {
  loader: LoaderDefinition<PriceData>;
  testId: string;
}) {
  const { data } = useLoader(loader);

  const entries = Object.entries(data.prices).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <div data-testid={`${testId}-prices`}>
      <ul>
        {entries.map(([id, price]) => (
          <li key={id} data-testid={`${testId}-price-${id}`}>
            {id}: ${price.toFixed(2)}
          </li>
        ))}
      </ul>
      <span data-testid={`${testId}-price-count`}>{entries.length}</span>
      <span data-testid={`${testId}-fetched-at`}>{data.fetchedAt}</span>
    </div>
  );
}
