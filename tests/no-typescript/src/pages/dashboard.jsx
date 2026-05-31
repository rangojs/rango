import { Metrics } from "../components/Metrics.jsx";

export function DashboardPage() {
  return (
    <div data-testid="dashboard-page">
      <h1 data-testid="dashboard-title">Dashboard</h1>
      <p>
        A registered loader provides the value; bumping it triggers
        revalidation.
      </p>
      <Metrics />
    </div>
  );
}
