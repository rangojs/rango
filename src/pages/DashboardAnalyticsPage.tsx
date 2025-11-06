import React from 'react';

export default function DashboardAnalyticsPage() {
  console.log('[DashboardAnalyticsPage] Rendering');

  return (
    <div>
      <h2>Analytics</h2>
      <p>View your site analytics and metrics.</p>
      <div style={{ marginTop: '2rem', padding: '2rem', background: '#f9f9f9', borderRadius: '8px' }}>
        <h3>Traffic Overview</h3>
        <p>Page Views: 12,345</p>
        <p>Unique Visitors: 3,456</p>
        <p>Bounce Rate: 32%</p>
        <p>Avg. Session Duration: 4:32</p>
      </div>
    </div>
  );
}