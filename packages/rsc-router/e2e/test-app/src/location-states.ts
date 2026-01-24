import { createLocationState } from "@ivogt/rsc-router/client";

export interface SlowProductState {
  productName: string;
  productPrice: number;
}

export const SlowProductLocationState = createLocationState<SlowProductState>();
