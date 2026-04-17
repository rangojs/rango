import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async increment() {
    return 1;
  }
}
