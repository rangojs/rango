// Stub for the `cloudflare:email` runtime virtual, shipped for Cloudflare
// consumers (enable via `rangoTestAliases({ preset: "cloudflare" })`).
export class EmailMessage {
  constructor(
    public from: string,
    public to: string,
    public raw: unknown,
  ) {}
}
