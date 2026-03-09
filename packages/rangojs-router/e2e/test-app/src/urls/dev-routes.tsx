import { urls } from "@rangojs/router";

function DevInfoPage() {
  return (
    <div data-testid="dev-info-page">
      <h1>Dev Info</h1>
      <p>This page only exists while the app runs in development mode.</p>
    </div>
  );
}

export const devDebugPatterns = urls(({ path }) => [
  path("/routes", () => (
    <div data-testid="debug-routes-page">
      <h1>Route Debugger</h1>
      <p>This debug page is mounted through import.meta.env.DEV.</p>
    </div>
  )),
]);

export const devInfoHandler = DevInfoPage;
