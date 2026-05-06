import { createLocationState } from "@rangojs/router";

export interface SlowProductState {
  productName: string;
  productPrice: number;
}

export const SlowProductLocationState = createLocationState<SlowProductState>();

export interface PrerenderTestState {
  tag: string;
}

export const PrerenderTestLocationState =
  createLocationState<PrerenderTestState>();

export interface FlashMessageState {
  text: string;
}

export const FlashMessage = createLocationState<FlashMessageState>({
  flash: true,
});

export interface ServerInfoState {
  data: string;
}

export const ServerInfo = createLocationState<ServerInfoState>();

export interface StaticWriteDemoState {
  label: string;
  count: number;
}

export const StaticWriteDemo = createLocationState<StaticWriteDemoState>();
