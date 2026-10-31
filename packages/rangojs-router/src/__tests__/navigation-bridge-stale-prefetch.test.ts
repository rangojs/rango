/**
 * #1329: a click on a prefetch a server action marked stale commits it as any
 * prefetched click does, then revalidates the page once the click settled,
 * in Back's stale-revalidation lane (navigation-bridge.ts
 * revalidateStalePrefetch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchPartialUpdateMock, createNavigationTransactionMock } = vi.hoisted(
  () => ({
    fetchPartialUpdateMock: vi.fn(),
    createNavigationTransactionMock: vi.fn(),
  }),
);

vi.mock("../browser/partial-update.js", () => ({
  createPartialUpdater: vi.fn(() => fetchPartialUpdateMock),
  shouldStartViewTransition: vi.fn(() => false),
}));

vi.mock("../browser/navigation-transaction.js", () => ({
  resolveNavigationState: vi.fn((state: unknown) => state),
  createNavigationTransaction: vi.fn((...args: unknown[]) =>
    createNavigationTransactionMock(...args),
  ),
}));

import { createNavigationBridge } from "../browser/navigation-bridge";
import { __resetActionFence, enterActionFence } from "../browser/action-fence";

const CART = "http://localhost/cart";
const SEGMENTS = [
  { id: "L0", type: "layout" },
  { id: "L0D0.basket", type: "loader" },
  { id: "L0R1", type: "route" },
];

interface Settling {
  abort: AbortController;
  settled: Promise<boolean>;
  settle(committed: boolean): void;
}

function makeEntry(): Settling {
  let settle!: (committed: boolean) => void;
  const settled = new Promise<boolean>((resolve) => (settle = resolve));
  return { abort: new AbortController(), settled, settle };
}

function makeTx(abort: AbortController) {
  return {
    handle: { signal: abort.signal, abort },
    commit: vi.fn(),
    with: vi.fn((opts: unknown) => opts),
    [Symbol.dispose]: vi.fn(),
  };
}

function setup() {
  let historyKey = "http://localhost/";
  const cached = new Map<string, any>([
    [CART, { segments: SEGMENTS, stale: false, handleData: { h: {} } }],
  ]);
  const store = {
    getHistoryKey: vi.fn(() => historyKey),
    rememberDisplayedEntry: vi.fn(),
    getHistoryEntryMemory: vi.fn(() => undefined),
    getCachedSegments: vi.fn((key: string) => cached.get(key)),
    hasInterceptCache: vi.fn(() => false),
    cacheSegmentsForHistory: vi.fn(),
    updateCacheHandleData: vi.fn(),
    setInterceptSourceUrl: vi.fn(),
    setCrossTabRefreshCallback: vi.fn(),
    setHistoryKey: vi.fn(),
    setCurrentUrl: vi.fn(),
    getInterceptSourceUrl: vi.fn((): string | null => null),
  };
  const click = makeEntry();
  const revalidation = makeEntry();
  let unsettled: Settling | null = click;
  const eventController = {
    abortNavigation: vi.fn(),
    getHandleState: vi.fn(() => ({ data: {} })),
    getHydrationSnapshot: vi.fn(() => undefined),
    commitLocationState: vi.fn(),
    getUnsettledNavigation: vi.fn(() => unsettled),
  };
  createNavigationTransactionMock
    .mockReturnValueOnce(makeTx(click.abort))
    .mockReturnValueOnce(makeTx(revalidation.abort));
  const bridge = createNavigationBridge({
    store: store as any,
    client: {} as any,
    eventController: eventController as any,
    onUpdate: vi.fn(),
    renderSegments: vi.fn(async () => "tree"),
  });
  return {
    bridge,
    store,
    click,
    /** The click committed: the store moved to its entry. */
    commit: () => {
      historyKey = CART;
    },
    moveTo: (key: string) => {
      historyKey = key;
    },
    settle: async (committed: boolean) => {
      unsettled = null;
      click.settle(committed);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    startOther: () => {
      unsettled = makeEntry();
    },
  };
}

describe("navigation-bridge click on a stale prefetch", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: { href: CART, origin: "http://localhost" },
      history: { state: {}, pushState: vi.fn(), replaceState: vi.fn() },
    });
    __resetActionFence();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchPartialUpdateMock.mockReset();
    createNavigationTransactionMock.mockReset();
    __resetActionFence();
  });

  /** The click's response is a stale prefetch, and it commits. */
  function staleClick(env: ReturnType<typeof setup>) {
    fetchPartialUpdateMock.mockImplementationOnce(
      async (_url, _ids, _retry, _signal, _tx, mode) => {
        mode.onStalePrefetch();
        env.commit();
      },
    );
    fetchPartialUpdateMock.mockResolvedValue(undefined);
  }

  it("commits, then runs one stale revalidation of the page with its ids held once the click settled", async () => {
    const env = setup();
    staleClick(env);

    await env.bridge.navigate("/cart");
    // The click's fill or stream is still open: nothing runs yet.
    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);

    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(2);
    const [url, heldIds, isRetry, , tx, mode] =
      fetchPartialUpdateMock.mock.calls[1]!;
    expect(url).toBe(CART);
    expect(heldIds).toEqual(["L0", "L0D0.basket", "L0R1"]);
    expect(isRetry).toBe(false);
    expect(mode).toEqual({
      type: "stale-revalidation",
      interceptSourceUrl: undefined,
      boundary: undefined,
    });
    expect(tx).toMatchObject({ url: CART, replace: true, cacheOnly: true });
    expect(createNavigationTransactionMock.mock.calls[1]![3]).toEqual({
      skipLoadingState: true,
      replace: true,
    });
    // The entry is stale until the revalidation re-caches it.
    expect(env.store.updateCacheHandleData).toHaveBeenCalledWith(
      CART,
      { h: {} },
      true,
    );
  });

  it("runs nothing for a click on a fresh prefetch", async () => {
    const env = setup();
    fetchPartialUpdateMock.mockImplementationOnce(async () => env.commit());

    await env.bridge.navigate("/cart");
    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
    expect(env.store.updateCacheHandleData).not.toHaveBeenCalledWith(
      CART,
      expect.anything(),
      true,
    );
  });

  it("runs nothing when the click was left before it settled", async () => {
    const env = setup();
    staleClick(env);

    await env.bridge.navigate("/cart");
    env.click.abort.abort();
    await env.settle(false);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("only marks the entry stale when the page moved since the commit", async () => {
    const env = setup();
    staleClick(env);

    await env.bridge.navigate("/cart");
    env.moveTo("http://localhost/cart?tab=2");
    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
    expect(env.store.updateCacheHandleData).toHaveBeenCalledWith(
      CART,
      { h: {} },
      true,
    );
  });

  it("only marks the entry stale while another navigation is open", async () => {
    const env = setup();
    staleClick(env);

    await env.bridge.navigate("/cart");
    env.startOther();
    await new Promise((resolve) => setTimeout(resolve, 0));
    env.click.settle(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the page to the follow-up of an action in flight", async () => {
    const env = setup();
    staleClick(env);

    await env.bridge.navigate("/cart");
    enterActionFence();
    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
  });
});
