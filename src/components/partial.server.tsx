import type { RscPayload } from "../framework/entry.rsc";

import { createFromReadableStream } from "@vitejs/plugin-rsc/rsc";
export const Partial = async ({ path }: { path: string }) => {
  const res = await fetch(`http://localhost:5173${path}`, {
    headers: {
      // Ensure we're requesting RSC format
      accept: "text/x-component",
    },
  });
  const payload = await createFromReadableStream<RscPayload>(res.body!);
  console.log("payload", payload);
  function FixSsrThenable(props: React.PropsWithChildren) {
    return props.children;
  }
  return <FixSsrThenable>{payload.root}</FixSsrThenable>;
};
