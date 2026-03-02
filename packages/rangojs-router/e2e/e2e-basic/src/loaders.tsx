import { createLoader } from "@rangojs/router";

// ReactNode loader — returns JSX, only works through RSC Flight serialization.
let reactNodeLoaderCount = 0;
export const ReactNodeTestLoader = createLoader(async () => {
  reactNodeLoaderCount++;
  const ts = new Date().toISOString();
  return (
    <>
      <span data-testid="rn-count">{reactNodeLoaderCount}</span>
      <span data-testid="rn-ts">{ts}</span>
    </>
  );
});

// Null loader — returns an object with a null value field.
// The cache must store and return null, not treat it as a miss.
let nullLoaderCount = 0;
export const NullTestLoader = createLoader(async () => {
  nullLoaderCount++;
  return { value: null, count: nullLoaderCount };
});
