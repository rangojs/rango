// SPIKE (keep lab): the five ways the lab's pages are mounted, side by side.
// Each mode has the same three pages under a layout with the same nav.

export type KeepLabMode =
  | "plain"
  | "transition"
  | "keep"
  | "keep-two-step"
  | "group";

export type KeepLabPageName = "a" | "b" | "c";

export const KEEP_LAB_PAGES: readonly KeepLabPageName[] = ["a", "b", "c"];

export interface KeepLabModeInfo {
  mode: KeepLabMode;
  label: string;
  /** How the area is built. */
  setup: string;
  /** What to watch for when you come back to a page. */
  watch: string;
}

export const KEEP_LAB_MODES: readonly KeepLabModeInfo[] = [
  {
    mode: "plain",
    label: "1. No keep",
    setup: "Server routes under a urls() layout with a plain <Outlet />.",
    watch:
      "Today's router. A page you come back to mounts again: its instance number goes up, and the typed text, the open panel and the list's scroll are gone. When its route re-runs (the search link), its skeleton shows until the new read lands.",
  },
  {
    mode: "transition",
    label: "2. No keep, transition()",
    setup:
      "The same, with transition() on the layout: the navigation commits in a transition, with the router's cross-fade.",
    watch:
      "The page you leave stays for about a frame, then the next page shows with its skeleton: transition() holds a page that stays on screen, not one that mounts. A page you come back to still mounts again and loses its state.",
  },
  {
    mode: "keep",
    label: "3. Keep, one step",
    setup:
      "Server routes; the layout renders <Outlet keep={{ max: 2 }} />, so the two pages you left stay mounted and hidden.",
    watch:
      "Coming back keeps the same instance, the typed text and the open panel; the list's scroll goes back to the top. When the route re-runs (the search link), the kept page shows its skeleton until the new read lands.",
  },
  {
    mode: "keep-two-step",
    label: "4. Keep, two steps",
    setup:
      'As 3, with reveal: "two-step": the kept page shows with its last data in the navigation\'s commit, then the new element swaps in a transition.',
    watch:
      "Coming back keeps the instance and its state (not the list's scroll). On the search link the page shows at once with its old read number and time, and they change once when the new read lands: no skeleton.",
  },
  {
    mode: "group",
    label: "5. Keep, clientUrls group",
    setup:
      'A clientUrls() group whose layout renders <Outlet keep={{ max: 2, by: "route" }} />; a click shows the optimistic frame at once.',
    watch:
      "Coming back keeps the instance and its state (not the list's scroll) and shows the old read at the click, then one swap. Watch the title and the crumbs on the search link while the read is pending.",
  },
];

export function keepLabModeInfo(mode: KeepLabMode): KeepLabModeInfo {
  return KEEP_LAB_MODES.find((info) => info.mode === mode)!;
}
