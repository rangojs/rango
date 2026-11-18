// What useHandle's equality (samePushValue) sees once a crumb has crossed the
// real Flight codec: each value is serialized and decoded twice, as two
// responses carrying the same crumbs would be. Runs in the rsc project.
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { renderServerTree } from "../flight.entry.js";
import { samePushValue } from "../../handles/client-pushes.js";
import { Counter } from "./fixtures/Counter.js";

interface Crumb {
  label: string;
  href: string;
  /** What decoding gave back: an element, a lazy value or text. */
  content: unknown;
}

/** Decode a trail whose last crumb holds `content()`, a fresh element each call. */
async function decoded(content: () => ReactNode): Promise<Crumb[]> {
  const trail = [
    { label: "Home", href: "/", content: "Home" },
    { label: "Order", href: "/orders/1", content: content() },
  ];
  // The kit types its input as a node; a trail is plain data Flight encodes.
  const { tree } = await renderServerTree(trail as unknown as ReactNode);
  return tree as Crumb[];
}

async function Total(): Promise<ReactNode> {
  await Promise.resolve();
  return <i>12</i>;
}

describe("useHandle equality on Flight-decoded crumbs", () => {
  test("a host element in `content` decodes equal, so the reader keeps its reference", async () => {
    const host = () => <b className="crumb">Order</b>;
    const [a, b] = [await decoded(host), await decoded(host)];
    expect(a).not.toBe(b);
    expect(samePushValue(a, b)).toBe(true);
  });

  test("a client component in `content` decodes as a fresh lazy type each time, so it is never equal", async () => {
    const client = () => (
      <Counter start={1} when={new Date(0)} tags={new Map()} />
    );
    const [a, b] = [await decoded(client), await decoded(client)];
    const typeOf = (trail: Crumb[]) =>
      (trail.at(-1)!.content as { type: { $$typeof: symbol } }).type;
    expect(typeOf(a).$$typeof).toBe(Symbol.for("react.lazy"));
    expect(typeOf(a)).not.toBe(typeOf(b));
    expect(samePushValue(a, b)).toBe(false);
    // What an effect should key on instead: a primitive the crumb carries.
    expect(samePushValue(a.at(-1)!.href, b.at(-1)!.href)).toBe(true);
  });

  test("async server content decodes as a fresh lazy value each time, so it is never equal", async () => {
    const pending = () => <Total />;
    const [a, b] = [await decoded(pending), await decoded(pending)];
    expect((a.at(-1)!.content as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.lazy"),
    );
    expect(samePushValue(a, b)).toBe(false);
    expect(samePushValue(a.at(-1)!.label, b.at(-1)!.label)).toBe(true);
  });
});
