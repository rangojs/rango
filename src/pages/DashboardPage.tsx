import React from 'react';

export default function DashboardPage() {
  console.log('[DashboardPage] Rendering');

  return (
    <div>
      <h2>Dashboard Overview</h2>
      <p>Welcome to your dashboard! Select an option from the sidebar.</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '2rem' }}>
        <div style={{ padding: '1rem', background: '#f0f0f0', borderRadius: '8px' }}>
          <h3>Stats</h3>
          <p>Total Users: 1,234</p>
          <p>Active Sessions: 42</p>
        </div>
        <div style={{ padding: '1rem', background: '#f0f0f0', borderRadius: '8px' }}>
          <h3>Activity</h3>
          <p>Last Login: 2 hours ago</p>
          <p>New Messages: 5</p>
        </div>
      </div>
    </div>
  );
}