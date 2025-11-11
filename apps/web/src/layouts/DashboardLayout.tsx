import React from 'react';
import { Outlet } from "rsc-router";

export default function DashboardLayout() {
  console.log('[DashboardLayout] Rendering');

  return (
    <div data-layout="dashboard" style={{ display: 'flex', gap: '2rem' }}>
      <aside style={{
        width: '200px',
        background: '#f5f5f5',
        padding: '1rem',
        borderRadius: '8px'
      }}>
        <h3>Dashboard Menu</h3>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <a href="/dashboard">Overview</a>
          <a href="/dashboard/analytics">Analytics</a>
          <a href="/dashboard/settings">Settings</a>
        </nav>
      </aside>
      <div style={{ flex: 1 }}>
        <Outlet />
      </div>
    </div>
  );
}