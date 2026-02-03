'use client';

import { useEffect, useState } from 'react';

interface SegmentTimerProps {
  segmentId?: string;
  serverRenderTime?: string;
}

/**
 * Client component that shows:
 * 1. Server render timestamp (when segment was last rendered)
 * 2. Client timer (seconds since component mounted)
 *
 * If segment re-renders (revalidates), timer resets to 0
 * If segment is skipped (not revalidated), timer keeps counting
 */
export function SegmentTimer({ segmentId = 'Segment', serverRenderTime }: SegmentTimerProps) {
  const [seconds, setSeconds] = useState(0);
  const [renderTime] = useState(() => serverRenderTime || new Date().toISOString());

  useEffect(() => {
    // Reset timer when component mounts (segment re-rendered)
    setSeconds(0);

    const interval = setInterval(() => {
      setSeconds(s => s + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [renderTime]); // Reset when renderTime changes

  return (
    <div style={{
      background: seconds < 3 ? '#d1f2eb' : '#fff3cd',
      border: `2px solid ${seconds < 3 ? '#0f5132' : '#856404'}`,
      padding: '0.75rem',
      borderRadius: '6px',
      fontSize: '0.85rem',
      marginTop: '1rem',
      fontFamily: 'monospace',
    }}>
      <div style={{ marginBottom: '0.5rem' }}>
        <strong>Segment:</strong> <code>{segmentId}</code>
      </div>
      <div style={{ marginBottom: '0.5rem' }}>
        <strong>Server Rendered:</strong> {renderTime}
      </div>
      <div style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>
        ⏱️ Client Age: <span style={{
          color: seconds < 3 ? '#0f5132' : '#856404'
        }}>{seconds}s</span>
      </div>
      <div style={{
        marginTop: '0.5rem',
        fontSize: '0.75rem',
        color: '#666',
        fontStyle: 'italic'
      }}>
        {seconds < 3
          ? '✨ Recently re-rendered'
          : '♻️ Reused from client (no revalidation)'}
      </div>
    </div>
  );
}
