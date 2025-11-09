/**
 * Example App Entry Point
 *
 * Run this file to see the RSC Router in action:
 * - npm run start
 * - npm run dev (watch mode)
 */

import router from './server';
import {
  buildSegmentMap,
  parseClientSegments,
  createRSCPayload,
  type Segment,
} from '../../src/segment-system';

console.log('🚀 RSC Router Example - Basic Demo\n');
console.log('This example demonstrates partial rendering with the RSC Router.');
console.log('Watch how the router computes differential updates!\n');

// ============================================================================
// SIMULATE REQUESTS
// ============================================================================

async function simulateRequest(
  pathname: string,
  clientHas: string = '',
  description: string
) {
  console.log('\n' + '='.repeat(70));
  console.log(`📍 ${description}`);
  console.log('='.repeat(70));

  const url = clientHas
    ? `http://localhost:3000${pathname}?_has=${clientHas}`
    : `http://localhost:3000${pathname}`;

  console.log(`\nRequest: GET ${pathname}`);
  if (clientHas) {
    console.log(`Client has: ${clientHas}`);
  } else {
    console.log(`Client has: (empty - initial load)`);
  }

  const request = new Request(url);
  const match = await router.match(request);

  if (!match) {
    console.log('❌ No route matched\n');
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
  const clientHasSet = parseClientSegments(hasParam);

  // Create payload
  const payload = createRSCPayload(targetSegments, clientHasSet);

  // Display results
  console.log(`\n📊 Server Response:`);
  console.log(`   Segments: ${payload.segments.join(', ')}`);
  console.log(`   Updates: ${Object.keys(payload.updates).join(', ') || '(none)'}`);

  const keptCount = payload.segments.length - Object.keys(payload.updates).length;
  const updatedCount = Object.keys(payload.updates).length;
  const percentage = payload.segments.length > 0
    ? Math.round((keptCount / payload.segments.length) * 100)
    : 0;

  console.log(`\n💾 Efficiency:`);
  console.log(`   Segments kept: ${keptCount}/${payload.segments.length} (${percentage}% reused)`);
  console.log(`   Segments updated: ${updatedCount}`);
  console.log(`   Estimated bandwidth saved: ~${keptCount * 10}KB`);

  // Show segment details
  console.log(`\n🔍 Segment Details:`);
  targetSegments.forEach((seg) => {
    const isUpdate = seg.id in payload.updates;
    const status = isUpdate ? '⚠️  UPDATE' : '✅ KEPT';
    const slotInfo = seg.slot ? ` (${seg.slot})` : '';
    const paramInfo = seg.params ? ` params: ${JSON.stringify(seg.params)}` : '';
    console.log(`   ${status} ${seg.id}: ${seg.type}${slotInfo}${paramInfo}`);
  });
}

// ============================================================================
// RUN EXAMPLES
// ============================================================================

(async () => {
  // Example 1: Initial page load
  await simulateRequest('/', '', 'Example 1: Initial Page Load (Home)');

  // Example 2: Navigate to features page
  await simulateRequest(
    '/features',
    'L0,R0',
    'Example 2: Navigate to Features (Same Layout)'
  );

  // Example 3: Navigate to blog index (structure change - add BlogLayout)
  await simulateRequest(
    '/blog',
    'L0,R1',
    'Example 3: Navigate to Blog Index (Nested Layouts)'
  );

  // Example 4: Navigate to blog post (adding parallel routes)
  await simulateRequest(
    '/blog/hello-world',
    'L0,L1,R2',
    'Example 4: Blog Post (Adds Parallel Routes @sidebar + @comments)'
  );

  // Example 5: Navigate to different post (partial update)
  await simulateRequest(
    '/blog/another-post',
    'L0,L1,R2,P3,P4',
    'Example 5: Different Post (Only R2 Updates - Parallel Routes Preserved)'
  );

  // Example 6: Navigate to category post (different route handler)
  await simulateRequest(
    '/blog/tech/react-tips',
    'L0,L1,R2,P3,P4',
    'Example 6: Category Post (Multiple Params)'
  );

  // Example 7: Navigate to archive with optional params
  await simulateRequest(
    '/blog/archive/2024/11',
    'L0,L1,R2,P3,P4',
    'Example 7: Archive (Optional Params Demonstration)'
  );

  // Example 8: Navigate to dashboard (structure change with different parallel routes)
  await simulateRequest(
    '/dashboard',
    'L0,L1,R2,P3,P4',
    'Example 8: Dashboard (Different Parallel Routes @sidebar + @notifications)'
  );

  // Example 9: Navigate within dashboard (no parallel on this route)
  await simulateRequest(
    '/dashboard/analytics',
    'L0,L1,R2,P3,P4',
    'Example 9: Dashboard Analytics (No Parallel Routes on This Route)'
  );

  // Example 10: Navigate to nested user route
  await simulateRequest(
    '/dashboard/users/123',
    'L0,L1,R2',
    'Example 10: User Detail (Nested Routes + Dynamic Param)'
  );

  // Example 11: API route with JSON response
  await simulateRequest(
    '/api/health',
    'L0,L1,R2',
    'Example 11: API Health Check (JSON Response)'
  );

  // Example 12: Wildcard route
  await simulateRequest(
    '/api/files/documents/report.pdf',
    'L0,R1',
    'Example 12: Wildcard Route (File Path)'
  );

  console.log('\n' + '='.repeat(70));
  console.log('🎉 Demo Complete!');
  console.log('='.repeat(70));
  console.log('\nKey Takeaways:');
  console.log('✅ Partial rendering saves 80-99% bandwidth');
  console.log('✅ Server computes differential based on client state');
  console.log('✅ Parallel routes are ADDITIVE (render alongside main content)');
  console.log('✅ Layouts persist across similar routes');
  console.log('✅ Only changed segments are sent to client\n');

  console.log('Try it yourself:');
  console.log('- npm run demo:parallel   # See parallel routes in action');
  console.log('- npm run demo:request    # See request handler flow\n');
})();
