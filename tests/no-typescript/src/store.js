// Plain server-side state shared by DashboardLoader (reads) and the
// bumpDashboard action (mutates). Imported only from server modules (a loader
// file and a "use server" file), so it never reaches the client bundle.
let dashboardValue = 0;

export function getDashboardValue() {
  return dashboardValue;
}

export function bumpDashboardValue() {
  dashboardValue += 1;
  return dashboardValue;
}
