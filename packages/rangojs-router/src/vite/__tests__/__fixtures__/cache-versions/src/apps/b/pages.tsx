"use client";

// Routes of app B defined in client code. The server learns them from a
// projection the build takes of this module (which loader a route declares,
// among other things), and that projection is in none of app B's chunks.
import { clientUrls, useLoader } from "@rangojs/router/client";
import { FirstLoader, SecondLoader } from "./pages.loader.js";

function First() {
  const { data } = useLoader(FirstLoader);
  return <p>{data}</p>;
}

function Second() {
  const { data } = useLoader(SecondLoader);
  return <p>{data}</p>;
}

export default clientUrls(({ path, loader }) => [
  path("/first", First, { name: "first" }, () => [loader(FirstLoader)]),
  path("/second", Second, { name: "second" }, () => [loader(SecondLoader)]),
]);
