import { createLocationState } from "@rangojs/router";

export interface SlowProductState {
  productName: string;
  productPrice: number;
}

export const SlowProductLocationState = createLocationState<SlowProductState>();

export interface PrerenderTestState {
  tag: string;
}

export const PrerenderTestLocationState = createLocationState<PrerenderTestState>();

export interface FlashMessageState {
  text: string;
}

export const FlashMessage = createLocationState<FlashMessageState>();

export interface ServerInfoState {
  data: string;
}

export const ServerInfo = createLocationState<ServerInfoState>();
