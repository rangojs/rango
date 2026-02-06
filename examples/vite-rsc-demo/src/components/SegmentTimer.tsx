'use client';

import { useEffect, useState } from 'react';

interface SegmentTimerProps {
  serverRenderTime: string;
}

/**
 * Shows when the segment was rendered on the server and how long ago.
 * Timer resets when serverRenderTime changes (segment re-rendered).
 * Timer keeps counting if segment is reused from cache.
 */
export function SegmentTimer({ serverRenderTime }: SegmentTimerProps) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    setSeconds(0);
    const interval = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(interval);
  }, [serverRenderTime]);

  return (
    <div style={{
      padding: '0.5rem',
      fontSize: '0.85rem',
      fontFamily: 'monospace',
      color: '#666',
    }}>
      <strong>Server Rendered:</strong> {serverRenderTime} | <strong>Client Age:</strong> {seconds}s
    </div>
  );
}
