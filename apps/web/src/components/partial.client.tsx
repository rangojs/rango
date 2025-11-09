"use client";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Await } from "./await";
import type { RscPayload } from "../framework/entry.rsc";

export const Partial = ({ promise }: { promise: Promise<RscPayload> }) => {
  return (
    <Suspense fallback={<Counter />}>
      <Await resolve={promise}>{(data) => data.root}</Await>
    </Suspense>
  );
};

export const Counter = () => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let id = setInterval(() => setCount((c) => c + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <>waiting for {count}</>;
};
