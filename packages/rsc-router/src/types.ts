import type { ComponentType, ReactNode } from 'react';

// Segment type definition - matches segment-system
export type SegmentType = 'layout' | 'route' | 'parallel';

export type Segment = {
  id: string; // Unique segment ID (e.g., 'L0', 'R2', 'P3')
  type: SegmentType; // Segment type
  index: number; // Sequential index
  pattern?: string; // Route pattern (e.g., '/blog/:id')
  component: ReactNode; // React component
  isLayout?: boolean; // Backward compatibility: true for layouts
  slot?: string; // For parallel routes (e.g., '@sidebar')
  path?: string; // Path for this segment
  params?: Record<string, string>; // Route params
};

// ResolvedSegment is a Segment with the handler already executed to ReactNode
export type ResolvedSegment = Segment;

export type RouteSegment = {
  /** The path segment (e.g., 'dashboard', ':id', '*') */
  path: string;
  /** Whether this is a dynamic segment (starts with ':') */
  isDynamic?: boolean;
  /** Whether this is a catch-all segment (is '*') */
  isCatchAll?: boolean;
  /** Layout component for this segment */
  layout?: ComponentType<{ children?: ReactNode }>;
  /** Page component for this segment (leaf nodes) */
  page?: ComponentType<any>;
  /** Child routes */
  children?: RouteSegment[];
  /** Optional metadata */
  meta?: {
    title?: string;
    description?: string;
  };
};

export type MatchedSegment = {
  path: string;
  params: Record<string, string>;
  layout?: ComponentType<{ children?: ReactNode }>;
  page?: ComponentType<any>;
  meta?: RouteSegment['meta'];
};

export type MatchedRoute = {
  pathname: string;
  segments: MatchedSegment[];
  params: Record<string, string>;
};

export type PartialRscPayload = {
  segments: {
    startIndex: number;
    components: ReactNode[];
  };
  metadata: {
    pathname: string;
    preservedLayouts: string[];
    params: Record<string, string>;
  };
};
