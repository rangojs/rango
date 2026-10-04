import { createLoader } from "@rangojs/router";

export const FirstLoader = createLoader(async () => "first");

export const SecondLoader = createLoader(async () => "second");
