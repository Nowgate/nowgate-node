// Safe retries: an idempotency key on every POST, the same for every attempt, and retries
// only of what the API says may change (api-docs-and-sdks.md section 2; ADR 0032).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConflictError,
  ConnectionError,
  InvalidRequestError,
  RateLimitError,
  ServerError,
} from "../src/index.ts";
import { fake, json, PAYMENT, problem, refused } from "./fake.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const create = { network: "tron", asset: "USDT", amount: "25" };

test("every POST carries a random idempotency key, the same on every attempt", async () => {
  const { nowgate, sent } = fake([problem(500, "internal_error"), refused(), json(201, PAYMENT)]);
  const { data, idempotency_key } = await nowgate.payments.create(create).withResponse();
  assert.deepEqual(data, PAYMENT);
  assert.equal(sent.length, 3);
  const keys = sent.map((s) => s.headers.get("idempotency-key"));
  assert.match(keys[0] ?? "", UUID);
  assert.deepEqual(keys, [keys[0], keys[0], keys[0]]);
  assert.equal(idempotency_key, keys[0]);
  assert.deepEqual(new Set(sent.map((s) => s.body)).size, 1);
});

test("each call gets its own key, and the caller's key is used as given", async () => {
  const { nowgate, sent } = fake([json(201, PAYMENT), json(201, PAYMENT), json(201, PAYMENT)]);
  await nowgate.payments.create(create);
  await nowgate.payments.create(create);
  await nowgate.payments.create(create, { idempotencyKey: "order-1042" });
  const keys = sent.map((s) => s.headers.get("idempotency-key"));
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[2], "order-1042");
  await assert.rejects(
    nowgate.payments.create(create, { idempotencyKey: "" }),
    /idempotencyKey must be a non-empty string/,
  );
});

test("GET, PUT, PATCH and DELETE carry no key and are retried by the same rules", async () => {
  const { nowgate, sent } = fake([
    problem(503, "pool_exhausted"),
    json(200, PAYMENT),
    problem(502, "http_502"),
    json(200, { rules: [] }),
    refused(),
    json(200, { id: "plink_1" }),
    problem(504, "http_504"),
    json(200, { id: "dst_1" }),
  ]);
  await nowgate.payments.retrieve("pay_1");
  await nowgate.forwarding.update({ rules: [] });
  await nowgate.paymentLinks.update("plink_1", { title: "T-shirt" });
  await nowgate.payoutDestinations.disable("dst_1");
  assert.deepEqual(
    sent.map((s) => s.method),
    ["GET", "GET", "PUT", "PUT", "PATCH", "PATCH", "DELETE", "DELETE"],
  );
  assert.ok(sent.every((s) => s.headers.get("idempotency-key") === null));
});

test("no answer is retried, then surfaces as a ConnectionError with its cause", async () => {
  const { nowgate, sent, waits } = fake([refused(), refused(), refused()]);
  await assert.rejects(nowgate.payments.create(create), (err: unknown) => {
    assert.ok(err instanceof ConnectionError);
    assert.match(
      err.message,
      /Couldn't reach Nowgate at https:\/\/sandbox-api.nowgate.io\/v1: ECONNREFUSED/,
    );
    assert.ok(err.cause instanceof TypeError);
    return true;
  });
  assert.equal(sent.length, 3);
  assert.deepEqual(waits, [500, 1000]);
});

test("an attempt that times out is retried, then is a ConnectionError", async () => {
  const hang = (s: { signal: AbortSignal | undefined }) =>
    new Promise<Response>((_, reject) => {
      s.signal?.addEventListener("abort", () => reject(s.signal?.reason));
    });
  const { nowgate, sent } = fake([hang, json(200, PAYMENT)], { timeout: 20 });
  assert.deepEqual(await nowgate.payments.retrieve("pay_1"), PAYMENT);
  assert.equal(sent.length, 2);

  const slow = fake([hang, hang], { timeout: 20, maxRetries: 1 });
  await assert.rejects(slow.nowgate.payments.retrieve("pay_1"), (err: unknown) => {
    assert.ok(err instanceof ConnectionError);
    assert.match(err.message, /didn't answer within 20 ms/);
    return true;
  });
});

test("409 idempotency_key_in_progress is retried after its Retry-After; other conflicts aren't", async () => {
  const { nowgate, sent, waits } = fake([
    problem(409, "idempotency_key_in_progress", { "Retry-After": "1" }),
    json(201, PAYMENT),
    problem(409, "payout_not_cancelable"),
  ]);
  await nowgate.payments.create(create);
  assert.deepEqual(waits, [1000]);
  await assert.rejects(nowgate.payouts.cancel("po_1"), ConflictError);
  assert.equal(sent.length, 3);
});

test("429 is retried after its Retry-After, in seconds or as a date, or with backoff", async () => {
  const soon = new Date(Date.now() + 3_000).toUTCString();
  const { nowgate, waits } = fake([
    problem(429, "rate_limited", { "Retry-After": "2" }),
    problem(429, "rate_limited", { "Retry-After": soon }),
    json(200, PAYMENT),
    problem(429, "rate_limited"),
    json(200, PAYMENT),
  ]);
  await nowgate.payments.retrieve("pay_1");
  await nowgate.payments.retrieve("pay_1");
  assert.equal(waits[0], 2000);
  assert.ok((waits[1] ?? 0) >= 2000 && (waits[1] ?? 0) <= 4000, `waited ${waits[1]}`);
  assert.equal(waits[2], 500);
});

test("a Retry-After over 60 seconds isn't waited for: the error carries it", async () => {
  const { nowgate, sent, waits } = fake([problem(429, "rate_limited", { "Retry-After": "61" })]);
  await assert.rejects(nowgate.payments.retrieve("pay_1"), (err: unknown) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.retry_after, 61);
    return true;
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(waits, []);
});

test("500, 502, 503 and 504 are retried; 501 isn't", async () => {
  for (const status of [500, 502, 503, 504]) {
    const { nowgate, sent } = fake([problem(status, "internal_error"), json(200, PAYMENT)]);
    assert.deepEqual(await nowgate.payments.retrieve("pay_1"), PAYMENT);
    assert.equal(sent.length, 2, `status ${status}`);
  }
  const { nowgate, sent } = fake([problem(501, "not_implemented")]);
  await assert.rejects(nowgate.payments.retrieve("pay_1"), ServerError);
  assert.equal(sent.length, 1);
});

test("other 4xx aren't retried, idempotency_key_reused among them", async () => {
  for (const [status, code] of [
    [422, "idempotency_key_reused"],
    [400, "invalid_request"],
    [401, "invalid_api_key"],
    [403, "insufficient_scope"],
    [404, "not_found"],
    [422, "amount_too_precise"],
  ] as const) {
    const { nowgate, sent } = fake([problem(status, code)]);
    await assert.rejects(nowgate.payments.create(create), (err: unknown) => {
      assert.equal((err as { code?: string }).code, code);
      return true;
    });
    assert.equal(sent.length, 1, code);
  }
  const { nowgate } = fake([problem(422, "idempotency_key_reused")]);
  await assert.rejects(nowgate.payments.create(create), InvalidRequestError);
});

test("two retries by default; per client and per call", async () => {
  const fails = (n: number) => Array.from({ length: n }, () => problem(503, "pool_exhausted"));
  const byDefault = fake(fails(3));
  await assert.rejects(byDefault.nowgate.payments.retrieve("pay_1"), ServerError);
  assert.equal(byDefault.sent.length, 3);

  const client = fake(fails(6), { maxRetries: 5 });
  await assert.rejects(client.nowgate.payments.retrieve("pay_1"), ServerError);
  assert.equal(client.sent.length, 6);
  assert.deepEqual(client.waits, [500, 1000, 2000, 4000, 8000]);

  const call = fake(fails(1));
  await assert.rejects(call.nowgate.payments.retrieve("pay_1", { maxRetries: 0 }), ServerError);
  assert.equal(call.sent.length, 1);
  await assert.rejects(call.nowgate.payments.retrieve("pay_1", { maxRetries: -2 }), /maxRetries/);
});

test("backoff doubles from half a second up to 8 seconds, each a random fraction of that", async () => {
  const fails = Array.from({ length: 7 }, () => problem(500, "internal_error"));
  const { nowgate, waits } = fake(fails, { maxRetries: 6 }, () => 0.5);
  await assert.rejects(nowgate.payments.retrieve("pay_1"), ServerError);
  assert.deepEqual(waits, [250, 500, 1000, 2000, 4000, 4000]);
});

test("an abort stops the call, during an attempt or a wait, and isn't retried", async () => {
  const controller = new AbortController();
  const { nowgate, sent } = fake([
    () => {
      controller.abort(new Error("stopped by the caller"));
      return problem(503, "pool_exhausted");
    },
  ]);
  await assert.rejects(
    nowgate.payments.retrieve("pay_1", { signal: controller.signal }),
    /stopped by the caller/,
  );
  assert.equal(sent.length, 1);

  const early = fake([]);
  await assert.rejects(
    early.nowgate.payments.retrieve("pay_1", { signal: AbortSignal.abort(new Error("gone")) }),
    /gone/,
  );
  assert.equal(early.sent.length, 0);
});

test("withResponse gives the status, the headers, the request ID and the idempotency facts", async () => {
  const { nowgate } = fake([
    json(201, PAYMENT, {
      "X-Request-Id": "req_123",
      "Idempotent-Replayed": "true",
      "Original-Request-Id": "req_100",
    }),
    json(200, PAYMENT, { "X-Request-Id": "req_124" }),
  ]);
  const created = await nowgate.payments.create(create, { idempotencyKey: "k1" }).withResponse();
  assert.equal(created.status, 201);
  assert.equal(created.request_id, "req_123");
  assert.equal(created.idempotency_key, "k1");
  assert.equal(created.idempotent_replayed, true);
  assert.equal(created.headers.get("original-request-id"), "req_100");
  const fetched = await nowgate.payments.retrieve("pay_1").withResponse();
  assert.equal(fetched.idempotent_replayed, false);
  assert.equal(fetched.idempotency_key, undefined);
});

test("a call's promise is a real Promise, and a failure reaches only its holder", async () => {
  const { nowgate } = fake([
    json(200, PAYMENT),
    problem(404, "not_found"),
    problem(404, "not_found"),
  ]);
  const call = nowgate.payments.retrieve("pay_1");
  assert.ok(call instanceof Promise);
  assert.deepEqual(await Promise.all([call]), [PAYMENT]);
  const code = await nowgate.payments.retrieve("pay_x").catch((err) => err.code);
  assert.equal(code, "not_found");
  const failed = nowgate.payments.retrieve("pay_x");
  await assert.rejects(failed.withResponse(), /not_found/);
  let finished = false;
  await failed
    .finally(() => {
      finished = true;
    })
    .catch(() => undefined);
  assert.ok(finished);
});
