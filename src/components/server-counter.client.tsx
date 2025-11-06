"use client";

import { startTransition } from "react";
import { updateServerCounter } from "../action";

export const ServerCounterClient = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const CallServerCounter = () => {
    startTransition(async () => {
      const counter = await updateServerCounter(1);
      console.log("CallServerCounter", counter);
    });
  };

  return (
    <form action={CallServerCounter} method="post">
      <button type="submit">{children}</button>
    </form>
  );
};
