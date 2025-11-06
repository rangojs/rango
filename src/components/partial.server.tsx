import { Suspense } from "react";
import type { RscPayload } from "../framework/entry.rsc";
import { Storage } from "../framework/entry.storage";
import {
  createFromReadableStream,
  createTemporaryReferenceSet,
  renderToReadableStream,
} from "@vitejs/plugin-rsc/rsc";
// export const Partial = async ({ path }: { path: string }) => {

//   return <MyTestPage />;
// };
export const Partial = async ({ path }: { path: string }) => {
  const temporaryReferences = createTemporaryReferenceSet();
  const Comp = await import("../MyTestPage").then((mod) => mod.MyTestPage);
  console.log("comp", Comp);

  const rscPayload: RscPayload = {
    root: <Comp />,
    //  formState,
    //  returnValue,
  };
  const rscOptions = { temporaryReferences };
  const rscStream = renderToReadableStream<RscPayload>(rscPayload, rscOptions);
  const [rscStream1, rscStream2] = rscStream.tee();
  const payload = await createFromReadableStream<RscPayload>(rscStream1);
  Storage.getStore().push(rscStream2);
  // console.log("Store:", Storage.getStore());

  // const reader = rscStream2.getReader();
  // const decoder = new TextDecoder();

  // while (true) {
  //   const { value, done } = await reader.read();
  //   if (done) break;
  //   console.log(decoder.decode(value));
  // }
  // console.log(
  //   "stream",
  //   await new Response(rscStream2).text()
  //   // await new Response(injectRSCPayload(rscStream2).readable).text()
  // );

  // console.log("payload", payload);
  function FixSsrThenable(props: React.PropsWithChildren) {
    // console.log("props", props);

    return <Suspense>{props.children}</Suspense>;
  }
  return <FixSsrThenable>{payload.root}</FixSsrThenable>;
};
