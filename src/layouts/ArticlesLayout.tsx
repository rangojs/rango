import React from 'react';
import { Outlet } from '../framework/router/Outlet';

export default function ArticlesLayout() {
  console.log('[ArticlesLayout] Rendering');

  return (
    <div>
      <div style={{
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        color: 'white',
        padding: '2rem',
        borderRadius: '8px',
        marginBottom: '2rem'
      }}>
        <h1>Articles & Blog</h1>
        <p>Read our latest insights and tutorials</p>
      </div>
      <Outlet />
    </div>
  );
}