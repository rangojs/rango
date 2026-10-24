// "use cache" functions for use-cache-returned-tree.rsc-test.tsx (wrapped by
// rangoUseCacheTransform() in vitest.rsc.config.ts). Most return a server
// component, which renders when the value is encoded.
import type { ReactElement, ReactNode } from "react";
import {
  cookies,
  createHandle,
  createVar,
  headers,
  type Handle,
  type HandlerContext,
} from "../../../index.rsc.js";

export type Kind = "cookies" | "headers";

export const state: {
  readOnRefresh: boolean;
  propsRuns: number;
  dataRuns: number;
} = {
  readOnRefresh: false,
  propsRuns: 0,
  dataRuns: 0,
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

/** A class instance: Flight cannot encode it. */
export class Money {
  constructor(readonly cents: number) {}
  format(): string {
    return `$${(this.cents / 100).toFixed(2)}`;
  }
}

/** What HandleBlock pushes: a component that reads the visitor. */
export const Notes: Handle<ReactNode> = createHandle<ReactNode>();

/** The reader is the value's root. */
export async function Block(kind: Kind): Promise<ReactElement> {
  "use cache";
  return <Reader kind={kind} />;
}

/** The reader is below the value's root. */
export async function NestedBlock(kind: Kind): Promise<ReactElement> {
  "use cache";
  return (
    <section>
      <b>nested</b>
      <Reader kind={kind} />
    </section>
  );
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

/** A data value holding a class instance. */
export async function PriceBlock(
  sku: string,
): Promise<{ sku: string; price: Money }> {
  "use cache";
  state.dataRuns += 1;
  return { sku, price: new Money(250) };
}

/** Pushes a component that reads the visitor into a handle. */
export async function HandleBlock(ctx: HandlerContext): Promise<string> {
  "use cache";
  ctx.use(Notes)(<Reader kind="cookies" />);
  return "handle-block";
}
