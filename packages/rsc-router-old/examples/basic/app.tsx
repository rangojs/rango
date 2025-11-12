/**
 * Example App - Browser Entry Point
 *
 * This is a simplified demonstration showing the router API.
 * Run with: npm run dev
 */

import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import router from './server';
import {
  buildSegmentMap,
  parseClientSegments,
  createRSCPayload,
  reconstructTreeFromSegments,
} from '../../src/segment-system';
import { SegmentStore, processPayload } from '../../src/client';

// Initialize store
const store = new SegmentStore();

function App() {
  const [currentPath, setCurrentPath] = useState('/');
  const [logs, setLogs] = useState<string[]>([]);
  const [segments, setSegments] = useState<string[]>([]);
  const [updates, setUpdates] = useState<string[]>([]);

  const addLog = (message: string) => {
    setLogs((prev) => [...prev, message]);
  };

  const navigate = async (pathname: string) => {
    addLog(`\n→ Navigating to: ${pathname}`);
    addLog(`   Current segments: ${store.getIds().join(', ') || '(none)'}`);

    try {
      const url = store.isEmpty()
        ? `http://localhost:3001${pathname}`
        : `http://localhost:3001${pathname}?_has=${store.getIds().join(',')}`;

      const request = new Request(url);
      const match = await router.match(request);

      if (!match) {
        addLog(`   ❌ No route matched`);
        return;
      }

      // Build segment map
      const targetSegments = buildSegmentMap({
        pathname: match.pathname,
        params: match.params,
        handlers: match.handlers,
      });

      // Parse client state
      const urlObj = new URL(url);
      const hasParam = urlObj.searchParams.get('_has');
      const clientHas = parseClientSegments(hasParam);

      // Create payload
      const payload = createRSCPayload(targetSegments, clientHas);

      addLog(`   📊 Server Response:`);
      addLog(`      Segments: ${payload.segments.join(', ')}`);
      addLog(`      Updates: ${Object.keys(payload.updates).join(', ') || '(none)'}`);

      const keptCount = payload.segments.length - Object.keys(payload.updates).length;
      addLog(`   💾 Kept: ${keptCount}/${payload.segments.length} segments (${Math.round((keptCount / payload.segments.length) * 100)}% reused)`);

      // Update state
      setSegments(payload.segments);
      setUpdates(Object.keys(payload.updates));

      // Process payload
      processPayload(payload, store);
      setCurrentPath(pathname);

      addLog(`   ✅ Navigation complete`);
    } catch (error: any) {
      addLog(`   ❌ Error: ${error.message}`);
    }
  };

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '20px' }}>
      <h1>🚀 RSC Router - Partial Rendering Demo</h1>

      <div style={{ marginBottom: '30px' }}>
        <h2>Current Route: {currentPath}</h2>
        <p>
          <strong>Segments in store:</strong> {store.getIds().join(', ') || '(none)'}
        </p>
      </div>

      <div style={{ marginBottom: '30px' }}>
        <h3>Navigation</h3>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button onClick={() => navigate('/')}>Home</button>
          <button onClick={() => navigate('/about')}>About</button>
          <button onClick={() => navigate('/blog')}>Blog Index</button>
          <button onClick={() => navigate('/blog/hello-world')}>Blog Post (hello-world)</button>
          <button onClick={() => navigate('/blog/another-post')}>Blog Post (another-post)</button>
          <button onClick={() => navigate('/blog/tech/react-tips')}>Blog Category</button>
          <button onClick={() => navigate('/dashboard')}>Dashboard</button>
          <button onClick={() => navigate('/dashboard/analytics')}>Dashboard Analytics</button>
          <button onClick={() => navigate('/dashboard/settings')}>Dashboard Settings</button>
        </div>
      </div>

      {segments.length > 0 && (
        <div style={{ marginBottom: '30px' }}>
          <h3>Last Response</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            <div>
              <h4>Segments (Complete List)</h4>
              <div style={{ background: '#f0f0f0', padding: '10px', borderRadius: '4px', fontFamily: 'monospace', fontSize: '14px' }}>
                {segments.map((id) => (
                  <div key={id}>{id}</div>
                ))}
              </div>
            </div>
            <div>
              <h4>Updates (Only Changed)</h4>
              <div style={{ background: '#fff3cd', padding: '10px', borderRadius: '4px', fontFamily: 'monospace', fontSize: '14px' }}>
                {updates.length > 0 ? (
                  updates.map((id) => <div key={id}>⚠️ {id}</div>)
                ) : (
                  <div style={{ color: '#666' }}>(no updates - 100% cached)</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom: '30px' }}>
        <h3>Log</h3>
        <div
          style={{
            background: '#000',
            color: '#0f0',
            padding: '15px',
            borderRadius: '4px',
            fontFamily: 'monospace',
            fontSize: '12px',
            height: '400px',
            overflowY: 'auto',
          }}
        >
          {logs.map((log, i) => (
            <div key={i}>{log}</div>
          ))}
        </div>
        <button
          onClick={() => setLogs([])}
          style={{ marginTop: '10px' }}
        >
          Clear Log
        </button>
      </div>

      <div>
        <h3>What's Happening?</h3>
        <ul>
          <li>Click navigation buttons to simulate SPA navigation</li>
          <li>Watch the log show <code>_has</code> parameter with current segments</li>
          <li>See the server compute differential (what changed)</li>
          <li>Notice bandwidth savings when navigating similar routes</li>
          <li><strong>Parallel routes (@sidebar, @modal) render ALONGSIDE main content</strong></li>
        </ul>
      </div>
    </div>
  );
}

// Mount app
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
