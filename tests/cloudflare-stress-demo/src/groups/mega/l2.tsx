/** Level 2 of the 3-level async include chain — see l1.tsx. */
import { makeMegaLevel } from "../../stress/chain-factories.js";

const megaL2 = makeMegaLevel(2, () => import("./l3.js"));

export default megaL2;
