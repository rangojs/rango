# Webhooks and WebCrypto on Workers

## Contents

- [Read the original request body](#read-the-original-request-body)
- [Test signed webhooks offline](#test-signed-webhooks-offline)
- [Port Node crypto carefully](#port-node-crypto-carefully)
- [Use Stripe 22 on workerd](#use-stripe-22-on-workerd)
- [Keep SDKs off the cold path](#keep-sdks-off-the-cold-path)

## Read the original request body

Signature verification must receive the exact bytes sent by the provider:

```typescript
path.json("/api/webhook", async (ctx) => {
  const rawBody = await ctx.request.text();
  const signature = ctx.request.headers.get("provider-signature");
  await verify(rawBody, signature);
  return { ok: true };
});
```

`path.json` describes the response representation; it does not parse or
reserialize the incoming request. Use `path.any` only when the handler needs a
fully manual `Response` contract or several methods/representations.

## Test signed webhooks offline

Use a fixed, non-production secret in the e2e environment. For Stripe, serialize
the body once, sign `${timestamp}.${rawBody}`, format the real
`stripe-signature` header, and send the same string:

```typescript
const rawBody = JSON.stringify(event);
const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(WEBHOOK_SECRET),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const signature = await crypto.subtle.sign(
  "HMAC",
  key,
  new TextEncoder().encode(`${timestamp}.${rawBody}`),
);
const hex = Array.from(new Uint8Array(signature), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("");

await request.post("/api/webhook", {
  data: rawBody,
  headers: {
    "content-type": "application/json",
    "stripe-signature": `t=${timestamp},v1=${hex}`,
  },
});
```

Assert the real D1 mutation through the public application route. Run the case
under both dev and preview. Do not pass an object to the HTTP client after
signing a string; another serialization can invalidate the signature.

## Port Node crypto carefully

TypeScript 5.9 defaults `Uint8Array` to `Uint8Array<ArrayBufferLike>`, while DOM
WebCrypto accepts `ArrayBufferView<ArrayBuffer>`. Annotate byte-producing
helpers that feed `crypto.subtle` precisely:

```typescript
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(atob(value).length);
  // fill bytes...
  return bytes;
}
```

WebCrypto AES-GCM returns `ciphertext || authenticationTag`. When preserving a
Node format that stored the tag separately, split the final 16 bytes on encrypt
and append them again before decrypting.

## Use Stripe 22 on workerd

Stripe 22 publishes a `workerd` export whose defaults use `fetch` and
SubtleCrypto. Webhook verification must use the asynchronous API; the sync API
cannot run a SubtleCrypto provider synchronously:

```bash
pnpm add stripe@^22
```

```typescript
import Stripe from "stripe";

path.json("/api/webhooks/stripe", async (ctx) => {
  const rawBody = await ctx.request.text();
  const signature = ctx.request.headers.get("stripe-signature");
  if (!signature) throw new Response("Missing signature", { status: 400 });

  const event = await Stripe.webhooks.constructEventAsync(
    rawBody,
    signature,
    ctx.env.STRIPE_WEBHOOK_SECRET,
  );

  await ctx.env.DB.prepare(
    "INSERT OR IGNORE INTO stripe_events (id, type, payload) VALUES (?, ?, ?)",
  )
    .bind(event.id, event.type, rawBody)
    .run();
  return { received: true };
});
```

Use a small idempotency table for the offline assertion:

```sql
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Using `Stripe.createFetchHttpClient()` and
`Stripe.createSubtleCryptoProvider()` explicitly is defensive but not required
when the `workerd` export is selected. Static `Stripe.webhooks` also means
signature verification does not require a fabricated API key or Stripe client
instance. The webhook signing secret, not the API secret key, authenticates the
payload.

These defaults are specific to Stripe 22. Revalidate the export map and crypto
provider behavior when upgrading the SDK major.

## Keep SDKs off the cold path

Put a large, rarely used webhook/billing group behind an async include:

```typescript
include("/", () => import("./urls/billing.js"), { name: "billing" });
```

Measure a before/after production build before claiming an SDK's incremental
cost. A chunk that contains the SDK is not itself proof that every byte was
introduced by that dependency.
