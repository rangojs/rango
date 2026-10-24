// "use cache" functions for use-cache-returned-tree.rsc-test.tsx (wrapped by
// rangoUseCacheTransform() in vitest.rsc.config.ts). Each returns a server
// component, which renders when the value is stored.
import type { ReactElement } from "react";
import {
  cookies,
  createVar,
  headers,
  type HandlerContext,
} from "../../../index.rsc.js";

export type Kind = "cookies" | "headers";

export const state: { readOnRefresh: boolean; propsRuns: number } = {
  readOnRefresh: false,
  propsRuns: 0,
};

/** Reads the visitor: the `session` cookie or the `x-visitor` header. */
async function Reader({ kind }: { kind: Kind }): Promise<ReactElement> {
  const visitor =
    kind === "cookies"
      ? cookies().get("session")?.value
      : headers().get("x-visitor");
  return <span>{`${kind}=${visitor ?? "none"}`}</span>;
}

/** Set by Writer through the ctx it receives. */
const Written = createVar<string>();

async function Writer({ ctx }: { ctx: HandlerContext }): Promise<ReactElement> {
  ctx.set(Written, "yes");
  return <i>written</i>;
}

function Greeting({ name }: { name: string }): ReactElement {
  return <span>{`hello ${name}`}</span>;
}

export async function Block(kind: Kind): Promise<ReactElement> {
  "use cache";
  return <Reader kind={kind} />;
}

/** Returns the reader only once state.readOnRefresh is set: on a refresh. */
export async function RefreshBlock(kind: Kind): Promise<ReactElement> {
  "use cache: short";
  return state.readOnRefresh ? <Reader kind={kind} /> : <b>first-value</b>;
}

export async function PropsBlock(name: string): Promise<ReactElement> {
  "use cache";
  state.propsRuns += 1;
  return <Greeting name={name} />;
}

export async function WriteBlock(ctx: HandlerContext): Promise<ReactElement> {
  "use cache";
  return <Writer ctx={ctx} />;
}
