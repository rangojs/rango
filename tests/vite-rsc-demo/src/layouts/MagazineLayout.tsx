import { Outlet } from "@rangojs/router/client";

export function MagazineLayout() {
  return (
    <div>
      <h1>Magazine</h1>
      <p className="segment-id">Segment: MagazineLayout</p>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
