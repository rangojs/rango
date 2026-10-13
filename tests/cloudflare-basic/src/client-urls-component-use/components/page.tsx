"use client";

import {
  Link,
  loader,
  loading,
  revalidate,
  useLoader,
  useOutlet,
} from "@rangojs/router/client";
import * as ComponentUseActions from "../actions.js";
import {
  ComponentUseItemLoader,
  ComponentUseShellLoader,
  ComponentUseStatsLoader,
} from "../loader.js";

export function ComponentUseLayout() {
  const { content } = useOutlet();
  const { data } = useLoader(ComponentUseShellLoader);
  return (
    <section data-testid="ccu-layout">
      <p data-testid="ccu-shell">{data}</p>
      {content}
    </section>
  );
}
ComponentUseLayout.use = () => [loader(ComponentUseShellLoader)];

export function ComponentUseItem() {
  const { data: item } = useLoader(ComponentUseItemLoader);
  const { data: stats } = useLoader(ComponentUseStatsLoader);
  return (
    <div data-testid="ccu-item">
      <p data-testid="ccu-item-data">{item}</p>
      <p data-testid="ccu-stats">{stats}</p>
      <Link
        to="/client-urls-component-use/items/beta"
        prefetch="none"
        data-testid="ccu-to-beta"
      >
        Beta
      </Link>
      <button
        data-testid="ccu-bump"
        onClick={() => void ComponentUseActions.bumpComponentUseStats()}
      >
        Bump stats
      </button>
      <button
        data-testid="ccu-other"
        onClick={() => void ComponentUseActions.otherComponentUseAction()}
      >
        Other action
      </button>
    </div>
  );
}
ComponentUseItem.use = () => [
  loader(ComponentUseStatsLoader, () => [
    revalidate(({ isAction }) =>
      isAction(ComponentUseActions.bumpComponentUseStats),
    ),
  ]),
  loader(ComponentUseItemLoader),
  loading(<p data-testid="ccu-skeleton">loading item</p>),
];
