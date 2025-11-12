import { hydrateRoot } from 'react-dom/client';
import { createFromFetch } from 'react-server-dom-webpack/client';
import type { RscPayload } from './entry.rsc.js';

console.log('[Browser] Initializing...');

// For now, just render a simple message
// Full implementation would deserialize RSC and hydrate
const root = document.getElementById('root');
if (root) {
  hydrateRoot(root, <div>
    <h1>RSC Router Demo</h1>
    <p>Loading...</p>
  </div>);
}

console.log('[Browser] Ready');
