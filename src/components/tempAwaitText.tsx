"use client";
import { Suspense, useEffect, useState } from "react";
import { Await } from "./await";

export const TempAwaitText = ({ promise }: { promise: Promise<string> }) => {
  return (
    <>
      cc:
      <Counter /> |
      <Suspense fallback={<Counter />}>
        <Await resolve={promise}>
          {(data) => <p>Data Load Status: 🎉 {data}</p>}
        </Await>
      </Suspense>
    </>
  );
};

export const Counter = () => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    console.log("Counter started!");

    let id = setInterval(() => setCount((c) => c + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <>waiting for {count}</>;
};
