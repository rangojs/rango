/**
 * Level 1 of the 3-level ASYNC include chain (/mega -> /mega/l2 ->
 * /mega/l2/l3). Every level is a `() => import()` provider, so the first
 * request to the deepest level awaits three chunk imports in sequence — the
 * deep nested-async-include path no other group exercises (shop's nesting is
 * eager inside one async module). The import thunk must stay a literal in
 * THIS module for Rollup to split the next level into its own chunk.
 */
import { makeMegaLevel } from "../../stress/chain-factories.js";

const megaL1 = makeMegaLevel(1, () => import("./l2.js"));

export default megaL1;
