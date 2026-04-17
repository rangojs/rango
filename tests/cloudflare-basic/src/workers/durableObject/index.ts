import { DurableObject } from "cloudflare:workers";
// `cloudflare:email` exercises the non-workers protocol stubs. Mirrors
// how third-party Cloudflare packages (e.g. the Agents SDK) pull email
// symbols in through the module graph during discovery.
import { EmailMessage } from "cloudflare:email";

export class Counter extends DurableObject {
  async increment() {
    return 1;
  }
}

export { EmailMessage };
