import type { ComponentType, ReactNode } from 'react';

export type Segment = {
  index: number;
  pattern: string;
  component: ReactNode;
  isLayout: boolean;
};

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
