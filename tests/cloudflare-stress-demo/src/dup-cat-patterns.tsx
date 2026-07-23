/**
 * One half of the same-staticPrefix sibling pair: /dup/:cat and /dup/:brand
 * both reduce to staticPrefix "/dup". The router cannot tell which sibling a
 * /dup/* request belongs to before importing, so BOTH async chunks load on
 * the first /dup hit (documented in async-includes.md) — this pair pins that
 * behavior. Route sets are disjoint by the segment AFTER the param.
 */
import { makeDupGroup } from "./stress/chain-factories.js";

const dupCatPatterns = makeDupGroup("dup-cat", "catPage", "cat-page");

export default dupCatPatterns;
