import { Outlet } from 'rsc-router/client';

export function BlogLayout() {
  return (
    <div>
      <h1>📝 Blog</h1>
      <p className="segment-id">Segment: BlogLayout</p>
      <Outlet />
    </div>
  );
}
