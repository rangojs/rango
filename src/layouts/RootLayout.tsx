import React from 'react';
import { Outlet } from '../framework/router/Outlet';

export default function RootLayout() {
  console.log('[RootLayout] Rendering');

  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Vite + RSC Router</title>
      </head>
      <body>
        <header style={{ background: '#333', color: 'white', padding: '1rem' }}>
          <nav style={{ display: 'flex', gap: '1rem' }}>
            <a href="/" style={{ color: 'white' }}>Home</a>
            <a href="/dashboard" style={{ color: 'white' }}>Dashboard</a>
            <a href="/articles" style={{ color: 'white' }}>Articles</a>
            <a href="/about" style={{ color: 'white' }}>About</a>
          </nav>
        </header>
        <main style={{ padding: '2rem' }}>
          <Outlet />
        </main>
        <footer style={{ background: '#333', color: 'white', padding: '1rem', marginTop: '2rem' }}>
          © 2024 RSC Router Demo
        </footer>
      </body>
    </html>
  );
}