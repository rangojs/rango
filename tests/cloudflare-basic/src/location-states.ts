import { createLocationState } from "@rangojs/router";

export interface FeatureState {
  name: string;
  description: string;
}

/**
 * FeatureLocationState - passes feature info during navigation.
 * Used to show feature details immediately in loading states.
 *
 * The key is auto-generated from file path + export name.
 */
export const FeatureLocationState = createLocationState<FeatureState>();
