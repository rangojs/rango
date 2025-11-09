"use client";

import { use, type ReactNode } from "react";

export const Await = <T,>({
  resolve,
  children,
}: {
  resolve: React.Usable<T>;
  children: (data: Awaited<T>) => ReactNode;
}) => {
  const data = use(resolve);
  return children(data as Awaited<T>);
};
