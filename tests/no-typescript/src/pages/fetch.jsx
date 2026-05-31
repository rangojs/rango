import { FetchWidget } from "../components/FetchWidget.jsx";

export function FetchPage() {
  return (
    <div data-testid="fetch-page">
      <h1 data-testid="fetch-title">Fetchable Loader</h1>
      <p>Click to fetch data on demand via useFetchLoader (GET).</p>
      <FetchWidget />
    </div>
  );
}
