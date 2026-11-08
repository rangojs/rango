/**
 * Which clientUrls() destinations the server segments above a group (its
 * chrome: layouts, their orphan layouts, parallels and loaders) stay right
 * for. An optimistic frame presents the destination under the chrome on
 * screen, and the canonical commit then re-renders every chrome segment
 * whose revalidate() asks for it. A frame shown under chrome the commit
 * re-renders is the destination under the source page's chrome for one
 * round trip: a category hero above a product. The frame declines those
 * destinations instead (beginClientUrlNavigation, navigation.ts).
 *
 * The browser cannot run the rules: they are server code. So the server asks
 * them once per render of a group route, for a navigation from this page to
 * a page with the same params, and records what they read of the
 * destination. A destination equal to this page on every read keeps their
 * decision; any other may change it.
 */

import type { EntryData } from "../server/context.js";
import type { HandlerContext, ShouldRevalidateFn } from "../types.js";

type RuleArgs = Parameters<ShouldRevalidateFn<any, any>>[0];

/**
 * ClientUrlsRoot's `chrome` prop. "any": a rule re-renders the chrome on a
 * navigation from this page, or read something of the destination other than
 * its params (its URL, its route name), or threw; no destination keeps it.
 * Otherwise `params` holds this page's value (null: absent) of each
 * destination param a rule read; `keys` that a rule enumerated the
 * destination's params, so `params` lists every one this page has and a
 * destination with another key differs too. No prop: no rule above the group,
 * or none read the destination.
 */
export type ChromeReads =
  | "any"
  | {
      readonly params: Readonly<Record<string, string | null>>;
      readonly keys?: true;
    };

type RuleOwner = {
  readonly rules: readonly ShouldRevalidateFn<any, any>[];
  readonly segmentType: "layout" | "parallel" | "loader";
  readonly layoutName?: string;
  readonly slotName?: string;
};

/** The rule chains of the segments `entry` renders beside its children. */
function collectOwned(
  entry: EntryData,
  into: RuleOwner[],
  seen: Set<EntryData>,
  slotName?: string,
): void {
  if (seen.has(entry)) return;
  seen.add(entry);
  if (entry.revalidate.length > 0) {
    into.push(
      entry.type === "parallel"
        ? { rules: entry.revalidate, segmentType: "parallel", slotName }
        : {
            rules: entry.revalidate,
            segmentType: "layout",
            layoutName: entry.id,
          },
    );
  }
  for (const loader of entry.loader) {
    if (loader.revalidate.length > 0) {
      into.push({ rules: loader.revalidate, segmentType: "loader" });
    }
  }
  for (const orphan of entry.layout) collectOwned(orphan, into, seen);
  for (const [slot, parallel] of Object.entries(entry.parallel)) {
    if (parallel) collectOwned(parallel, into, seen, slot);
  }
}

/** Every chrome rule chain above the group route `route`. */
function chromeRules(route: EntryData): RuleOwner[] {
  const owners: RuleOwner[] = [];
  const seen = new Set<EntryData>([route]);
  for (let entry = route.parent; entry; entry = entry.parent) {
    collectOwned(entry, owners, seen);
  }
  return owners;
}

const ANY = Symbol("any");

/**
 * The chrome reads of the page a group route renders. `params` are the
 * page's (the include() mount's included, as ctx.params), `context` its
 * handler context, `url` its URL, `routeName` its public route name.
 */
export function chromeReadsOf(
  route: EntryData,
  params: Readonly<Record<string, string>>,
  context: HandlerContext<any, any>,
  url: URL,
  routeName: string | undefined,
): ChromeReads | undefined {
  const owners = chromeRules(route);
  if (owners.length === 0) return undefined;

  const read = new Set<string>();
  let keys = false;
  // Not an inherited method (`nextParams.hasOwnProperty(...)`) or the hook
  // JSON.stringify looks up: no route names a param so.
  const record = (key: string | symbol): void => {
    if (
      typeof key === "string" &&
      key !== "toJSON" &&
      !(key in Object.prototype)
    ) {
      read.add(key);
    }
  };
  // A Proxy records a read of an absent key too: a rule comparing an absent
  // category with the destination's decides on it. Not structuredClone-able,
  // unlike router/source-reads.ts recordingParams; a probe needs no clone.
  const nextParams = new Proxy(
    { ...params },
    {
      get(target, key, receiver) {
        record(key);
        return Reflect.get(target, key, receiver);
      },
      has(target, key) {
        record(key);
        return Reflect.has(target, key);
      },
      getOwnPropertyDescriptor(target, key) {
        record(key);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        keys = true;
        return Reflect.ownKeys(target);
      },
    },
  );

  for (const owner of owners) {
    // The navigation default of a segment above the route: kept
    // (evaluateRevalidation's "nav:non-route-skip").
    let suggestion = false;
    // Typed as the rule's argument, so a field added there is a type error
    // here until the probe gives it a value.
    const args: RuleArgs = {
      currentParams: { ...params },
      currentUrl: url,
      nextParams,
      get nextUrl(): URL {
        throw ANY;
      },
      get defaultShouldRevalidate(): boolean {
        return suggestion;
      },
      context,
      segmentType: owner.segmentType,
      layoutName: owner.layoutName,
      slotName: owner.slotName,
      actionId: undefined,
      isAction: () => false,
      actionUrl: undefined,
      actionResult: undefined,
      formData: undefined,
      method: "GET",
      get routeName(): RuleArgs["routeName"] {
        throw ANY;
      },
      fromRouteName: routeName as RuleArgs["fromRouteName"],
      get toRouteName(): RuleArgs["toRouteName"] {
        throw ANY;
      },
      // A forward click is not a stale revalidation (`_rsc_stale` rides on
      // Back/Forward and action follow-ups). A route-cache entry past its
      // TTL is stale to the rules too; the browser cannot see that, and a
      // rule keyed on it would otherwise decline every frame.
      stale: false,
    };
    // The chain as evaluateRevalidation walks it: a boolean decides, a
    // { defaultShouldRevalidate } sets the suggestion, anything else defers.
    let decided: boolean | undefined;
    for (const rule of owner.rules) {
      let result: unknown;
      try {
        result = rule(args);
      } catch {
        // ANY, or the rule's own error, which the real evaluation logs and
        // falls back on: either way no destination is known to keep it.
        return "any";
      }
      if (typeof result === "boolean") {
        decided = result;
        break;
      }
      if (
        result &&
        typeof result === "object" &&
        "defaultShouldRevalidate" in result
      ) {
        suggestion = Boolean(
          (result as { defaultShouldRevalidate: unknown })
            .defaultShouldRevalidate,
        );
      }
    }
    if (decided ?? suggestion) return "any";
  }

  if (read.size === 0 && !keys) return undefined;
  const values: Record<string, string | null> = {};
  for (const key of keys ? [...read, ...Object.keys(params)] : read) {
    // An optional param the URL leaves out may be present as undefined.
    values[key] = Object.hasOwn(params, key) ? (params[key] ?? null) : null;
  }
  return keys ? { params: values, keys: true } : { params: values };
}

/**
 * Whether the chrome of the page that shipped `reads` stays right under a
 * frame of a destination with `params`.
 */
export function chromeKeeps(
  reads: ChromeReads | undefined,
  params: Readonly<Record<string, string | undefined>>,
): boolean {
  if (reads === undefined) return true;
  if (reads === "any") return false;
  const valueOf = (key: string): string | null =>
    Object.hasOwn(params, key) ? (params[key] ?? null) : null;
  for (const [key, value] of Object.entries(reads.params)) {
    if (valueOf(key) !== value) return false;
  }
  if (reads.keys) {
    for (const key of Object.keys(params)) {
      if (valueOf(key) !== null && !Object.hasOwn(reads.params, key)) {
        return false;
      }
    }
  }
  return true;
}
