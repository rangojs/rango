/**
 * Example: Server Request Handler
 *
 * Demonstrates the complete server-side partial rendering flow:
 * 1. Match route with middleware execution
 * 2. Build segment map from match
 * 3. Parse client state (_has parameter)
 * 4. Compute differential (what changed)
 * 5. Create RSC payload
 * 6. Return response
 */

import router from './server';
import {
  buildSegmentMap,
  parseClientSegments,
  createRSCPayload,
} from '../../src/segment-system';

/**
 * Handle incoming request with partial rendering support
 */
export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Request: ${request.method} ${pathname}`);

  // =========================================================================
  // 1. MATCH ROUTE (with middleware execution)
  // =========================================================================

  const match = await router.match(request);

  if (!match) {
    console.log('❌ No route matched');
    return new Response('Not Found', { status: 404 });
  }

  console.log(`✅ Route matched: ${pathname}`);
  console.log(`   Params: ${JSON.stringify(match.params)}`);

  // =========================================================================
  // 2. BUILD SEGMENT MAP
  // =========================================================================

  const targetSegments = buildSegmentMap({
    pathname: match.pathname,
    params: match.params,
    handlers: match.handlers,
  });

  console.log(`\n📊 Target segments (${targetSegments.length}):`);
  targetSegments.forEach((seg) => {
    const slotInfo = seg.slot ? ` (slot: ${seg.slot})` : '';
    const paramInfo = seg.params ? ` params: ${JSON.stringify(seg.params)}` : '';
    console.log(`   ${seg.id}: ${seg.type}${slotInfo}${paramInfo}`);
  });

  // =========================================================================
  // 3. PARSE CLIENT STATE
  // =========================================================================

  const hasParam = url.searchParams.get('_has');
  const clientHas = parseClientSegments(hasParam);

  console.log(`\n🖥️  Client state (_has parameter):`);
  if (clientHas.size === 0) {
    console.log('   (empty - initial navigation)');
  } else {
    console.log(`   Has: ${Array.from(clientHas).join(', ')}`);
  }

  // =========================================================================
  // 4. CREATE RSC PAYLOAD (Differential Rendering)
  // =========================================================================

  const payload = createRSCPayload(targetSegments, clientHas);

  console.log(`\n📦 RSC Payload:`);
  console.log(`   Segments: ${payload.segments.join(', ')}`);
  console.log(`   Updates: ${Object.keys(payload.updates).join(', ') || '(none)'}`);

  const keptCount = payload.segments.length - Object.keys(payload.updates).length;
  const savedBytes = keptCount * 10; // Rough estimate
  console.log(`   💾 Bandwidth saved: ~${savedBytes}KB (${keptCount} segments reused)`);

  // =========================================================================
  // 5. RETURN RESPONSE
  // =========================================================================

  console.log(`${'='.repeat(60)}\n`);

  // In production, use renderToRSCStream()
  // For this example, we return JSON
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'X-Segments': payload.segments.join(','),
      'X-Updates': Object.keys(payload.updates).join(','),
    },
  });
}

/**
 * Example usage with different request scenarios
 */
export const examples = {
  /**
   * Initial page load - no client state
   */
  async initialLoad() {
    const request = new Request('http://localhost:3000/blog/hello-world');
    return await handleRequest(request);
  },

  /**
   * Navigation to different post - client has L0, L1, R2
   */
  async navigateToDifferentPost() {
    const request = new Request(
      'http://localhost:3000/blog/another-post?_has=L0,L1,R2,P3,P4'
    );
    return await handleRequest(request);
  },

  /**
   * Navigation to different section - structure change
   */
  async navigateToDashboard() {
    const request = new Request(
      'http://localhost:3000/dashboard?_has=L0,L1,R2,P3,P4'
    );
    return await handleRequest(request);
  },

  /**
   * Navigate deeper - adding segments
   */
  async navigateDeeper() {
    const request = new Request(
      'http://localhost:3000/blog/tech/react-tips?_has=L0,L1,R2'
    );
    return await handleRequest(request);
  },
};
