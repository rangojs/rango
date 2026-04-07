"use client";

import { useLoader } from "@rangojs/router/client";
import { ParallelInheritLoader } from "../loaders.js";
import { Component, type ReactNode } from "react";

class LoaderErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error) {
      return <div data-testid="parallel-loader-error">{this.state.error}</div>;
    }
    return this.props.children;
  }
}

function ParallelLoaderInner() {
  const { data } = useLoader(ParallelInheritLoader);
  return (
    <div data-testid="parallel-loader-data">
      {data.source}:{data.value}
    </div>
  );
}

export function ParallelLoaderClient() {
  return (
    <LoaderErrorBoundary>
      <ParallelLoaderInner />
    </LoaderErrorBoundary>
  );
}
