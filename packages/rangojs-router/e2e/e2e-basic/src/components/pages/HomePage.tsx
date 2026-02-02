import { UseHrefDemo } from "../UseHrefDemo.js";

export function HomePage() {
  return (
    <div data-testid="home-page">
      <h1 data-testid="home-title">Welcome</h1>
      <p data-testid="home-description">
        This app demonstrates the Django-style routing API.
      </p>
      <UseHrefDemo />
    </div>
  );
}
