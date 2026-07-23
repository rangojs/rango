/**
 * Server wrapper for the benchmark dashboard. All interactivity lives in the
 * client component; route-class descriptors are imported there directly
 * (builder functions cannot cross the RSC props boundary).
 */
import { BenchDashboard } from "./dashboard-client.js";

export const DashboardToolPage = () => <BenchDashboard />;
