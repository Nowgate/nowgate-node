# Nowgate for TypeScript

Nowgate's SDK for its merchant API: payments, payment links, payouts and refunds, with webhook
verification. It has no dependencies: it uses `fetch` and Web Crypto, so it runs on Node.js 22
and later, Deno, Bun and edge workers. It runs on servers only, since an API key must never reach
a browser.

```bash
npm install nowgate
```

## Create a payment

```ts
import { Nowgate } from "nowgate";

const nowgate = new Nowgate({ apiKey: process.env.NOWGATE_API_KEY! });

const payment = await nowgate.payments.create(
  { network: "tron", asset: "USDT", amount: "25.00", order_id: "1042" },
  { idempotencyKey: "order-1042" },
);
console.log(payment.id, payment.deposit.address, payment.amount);
```

The key picks the API: an `ngk_sandbox_…` key reaches the sandbox and an `ngk_live_…` key the
live API. Amounts are decimal strings, never floating-point numbers. A failed call is retried
safely with its idempotency key, and lists page with `listAll`.

## Verify a webhook

```ts
import { Webhooks } from "nowgate";

// body: the request's raw body, exactly as received; signature: its Nowgate-Signature header.
const event = await Webhooks.constructEvent(body, signature, process.env.NOWGATE_WEBHOOK_SECRET!);
```

## Documentation

The guides and the API reference are at [docs.nowgate.io](https://docs.nowgate.io), and this
SDK's page is [docs.nowgate.io/sdks/typescript](https://docs.nowgate.io/sdks/typescript).
[CHANGELOG.md](CHANGELOG.md) lists its releases, each with the API version it was made for.
