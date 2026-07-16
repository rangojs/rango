"use client";

import { Suspense, use, useState } from "react";
import { useLoader } from "@rangojs/router/client";
import {
  CACHE_LAB_TAGS,
  type CacheLabProductId,
  type CacheLabProductSnapshot,
} from "../cache-lab-contract.js";
import type { CacheLabPulseLoader } from "../cache-lab-data.js";

interface CacheLabProductGridProps {
  products: readonly {
    id: CacheLabProductId;
    product: CacheLabProductSnapshot;
  }[];
}

function ProductCard({ product }: { product: CacheLabProductSnapshot }) {
  return (
    <article
      className="cache-lab-product"
      data-cache-product={product.id}
      data-cache-token={product.cacheToken}
      data-testid={`cache-lab-product-${product.id}`}
    >
      <div className="cache-lab-product-topline">
        <span className="cache-lab-eyebrow">use cache</span>
        <strong>{product.price}</strong>
      </div>
      <h3>{product.name}</h3>
      <dl className="cache-lab-facts">
        <div>
          <dt>Cache token</dt>
          <dd data-testid={`cache-lab-token-${product.id}`}>
            {product.cacheToken}
          </dd>
        </div>
        <div>
          <dt>Generated</dt>
          <dd>{product.generatedAt}</dd>
        </div>
      </dl>
      <div className="cache-lab-tag-list" aria-label="Cache tags">
        {product.tags.map((tag) => (
          <code key={tag}>{tag}</code>
        ))}
      </div>
    </article>
  );
}

export function CacheLabProductGrid({ products }: CacheLabProductGridProps) {
  return (
    <div className="cache-lab-product-grid">
      {products.map(({ id, product }) => (
        <ProductCard key={id} product={product} />
      ))}
    </div>
  );
}

function CacheLabLivePulseValue({
  generatedAt,
}: {
  generatedAt: Promise<string>;
}) {
  const value = use(generatedAt);
  return (
    <span data-live-pulse={value} data-testid="cache-lab-live-pulse">
      Live hole {value}
    </span>
  );
}

export function CacheLabLivePulse({
  loader,
}: {
  loader: typeof CacheLabPulseLoader;
}) {
  const { data } = useLoader(loader);
  return (
    <Suspense
      fallback={
        <span data-testid="cache-lab-live-pulse-loading">
          Streaming live pulse...
        </span>
      }
    >
      <CacheLabLivePulseValue generatedAt={data.generatedAt} />
    </Suspense>
  );
}

interface InvalidationState {
  kind: "idle" | "pending" | "success" | "error";
  message: string;
}

const INVALIDATION_OPTIONS = [
  {
    label: "Alpha only",
    tag: CACHE_LAB_TAGS.productAlpha,
    testId: "alpha",
  },
  {
    label: "Beta only",
    tag: CACHE_LAB_TAGS.productBeta,
    testId: "beta",
  },
  {
    label: "Entire catalog",
    tag: CACHE_LAB_TAGS.catalog,
    testId: "catalog",
  },
  {
    label: "PPR shell only",
    tag: CACHE_LAB_TAGS.shell,
    testId: "shell",
  },
] as const;

export function CacheLabInvalidationPanel() {
  const [state, setState] = useState<InvalidationState>({
    kind: "idle",
    message: "Choose a bounded tag. The API never accepts arbitrary tag names.",
  });

  async function invalidate(tag: string): Promise<void> {
    setState({ kind: "pending", message: `Invalidating ${tag}...` });

    try {
      const response = await fetch("/api/cache/invalidate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: [tag] }),
      });
      const body = (await response.json()) as {
        error?: string;
        invalidated?: string[];
      };

      if (!response.ok) {
        throw new Error(
          body.error ?? `Invalidation failed (${response.status})`,
        );
      }

      setState({
        kind: "success",
        message: `Invalidated ${body.invalidated?.join(", ") ?? tag}. Reload to observe the next cache generation.`,
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Invalidation failed",
      });
    }
  }

  return (
    <section className="cache-lab-console" aria-labelledby="cache-lab-console">
      <div>
        <span className="cache-lab-kicker">Public test mutation</span>
        <h2 id="cache-lab-console">Invalidation console</h2>
        <p>
          This test app exposes a public invalidation endpoint with a bounded
          tag allowlist. Secure this route before copying it into a real app.
        </p>
      </div>
      <div className="cache-lab-console-actions">
        {INVALIDATION_OPTIONS.map((option) => (
          <button
            data-testid={`cache-lab-invalidate-${option.testId}`}
            disabled={state.kind === "pending"}
            key={option.tag}
            onClick={() => void invalidate(option.tag)}
            type="button"
          >
            {option.label}
          </button>
        ))}
        <button
          className="cache-lab-secondary-button"
          data-testid="cache-lab-reload"
          onClick={() => window.location.reload()}
          type="button"
        >
          Reload page
        </button>
      </div>
      <output
        className={`cache-lab-console-status is-${state.kind}`}
        data-testid="cache-lab-invalidation-status"
      >
        {state.message}
      </output>
    </section>
  );
}
