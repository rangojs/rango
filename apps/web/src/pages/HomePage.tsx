import React from 'react';

export default function HomePage() {
  console.log('[HomePage] Rendering');

  return (
    <div>
      <h1>Welcome to RSC Router</h1>
      <p>This is the home page with nested layouts and partial rendering!</p>
      <div style={{ marginTop: '2rem' }}>
        <h2>Features:</h2>
        <ul>
          <li>Express/Hono-style routing</li>
          <li>Nested layouts with Outlet pattern</li>
          <li>Partial rendering on navigation</li>
          <li>Layout state preservation</li>
          <li>Middleware support</li>
        </ul>
      </div>
    </div>
  );
}