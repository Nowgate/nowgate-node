// Problems as errors: RFC 9457 problem JSON becomes the error of its status's class,
// carrying the whole problem (api-docs-and-sdks.md section 1.5).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  InvalidRequestError,
  NotFoundError,
  NowgateError,
  PermissionError,
  RateLimitError,
  ServerError,
  SignatureVerificationError,
} from "../src/index.ts";
import { fake, problem } from "./fake.ts";

test("a problem carries every field, its pointers and the docs page", async () => {
  const fields = [
    { pointer: "/amount", code: "amount_too_precise", detail: "USDT has 6 decimals." },
    { pointer: "/items/2/amount", code: "amount_invalid", detail: "Not a decimal." },
  ];
  const { nowgate } = fake([
    problem(
      422,
      "amount_too_precise",
      { "Retry-After": "5", "X-Request-Id": "req_h" },
      { errors: fields },
    ),
  ]);
  await assert.rejects(
    nowgate.payments.create({ network: "tron", asset: "USDT", amount: "1.0000001" }),
    (err: unknown) => {
      assert.ok(err instanceof InvalidRequestError);
      assert.ok(err instanceof ApiError && err instanceof NowgateError && err instanceof Error);
      assert.equal(err.name, "InvalidRequestError");
      assert.equal(err.status, 422);
      assert.equal(err.code, "amount_too_precise");
      assert.equal(err.title, "Problem");
      assert.equal(err.detail, "The amount_too_precise detail.");
      assert.equal(err.type, "https://docs.nowgate.io/errors/amount_too_precise");
      assert.equal(err.instance, "/v1/payments");
      assert.equal(err.request_id, "req_problem");
      assert.equal(err.retry_after, 5);
      assert.deepEqual(err.errors, fields);
      assert.equal(err.headers.get("x-request-id"), "req_h");
      assert.equal(
        err.message,
        "amount_too_precise: The amount_too_precise detail. (https://docs.nowgate.io/errors/amount_too_precise)",
      );
      return true;
    },
  );
});

test("each status has its class", async () => {
  const classes = [
    [400, InvalidRequestError],
    [401, AuthenticationError],
    [403, PermissionError],
    [404, NotFoundError],
    [405, InvalidRequestError],
    [409, ConflictError],
    [413, InvalidRequestError],
    [414, InvalidRequestError],
    [415, InvalidRequestError],
    [422, InvalidRequestError],
    [429, RateLimitError],
    [500, ServerError],
    [501, ServerError],
    [503, ServerError],
    [418, ApiError],
  ] as const;
  for (const [status, ErrorClass] of classes) {
    const { nowgate } = fake([problem(status, "some_code")], { maxRetries: 0 });
    await assert.rejects(nowgate.payments.retrieve("pay_1"), (err: unknown) => {
      assert.equal((err as object).constructor, ErrorClass, `status ${status}`);
      assert.equal((err as ApiError).status, status);
      return true;
    });
  }
});

test("an answer that isn't problem JSON is its status's error, with the body's first 500 bytes", async () => {
  const page = `<html><body>x${"é".repeat(400)}</body></html>`;
  const { nowgate } = fake(
    [
      new Response(page, {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "text/html", "X-Request-Id": "req_proxy" },
      }),
    ],
    { maxRetries: 0 },
  );
  await assert.rejects(nowgate.payments.retrieve("pay_1"), (err: unknown) => {
    assert.ok(err instanceof ServerError);
    assert.equal(err.code, "http_502");
    assert.equal(err.title, "Bad Gateway");
    assert.equal(err.type, undefined);
    assert.equal(err.request_id, "req_proxy");
    assert.ok(err.detail?.startsWith("<html><body>xéé"));
    assert.equal(new TextEncoder().encode(err.detail).length, 499);
    assert.ok(!err.detail?.includes("\ufffd"));
    assert.match(err.message, /^http_502: <html>/);
    return true;
  });
});

test("JSON that isn't a problem, and an empty answer, fall back the same way", async () => {
  const { nowgate } = fake(
    [
      new Response(JSON.stringify({ error: "nope" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
      new Response("", { status: 403 }),
    ],
    { maxRetries: 0 },
  );
  await assert.rejects(nowgate.payments.retrieve("pay_1"), (err: unknown) => {
    assert.ok(err instanceof NotFoundError);
    assert.equal(err.code, "http_404");
    assert.equal(err.detail, '{"error":"nope"}');
    return true;
  });
  await assert.rejects(nowgate.payments.retrieve("pay_1"), (err: unknown) => {
    assert.ok(err instanceof PermissionError);
    assert.equal(err.detail, undefined);
    assert.equal(err.message, "http_403: HTTP 403");
    return true;
  });
});

test("the errors without an answer are NowgateErrors, not ApiErrors", () => {
  const failure = new SignatureVerificationError("mismatch");
  assert.ok(failure instanceof NowgateError && !(failure instanceof ApiError));
  assert.equal(failure.reason, "mismatch");
  assert.equal(failure.name, "SignatureVerificationError");
  const connection = new ConnectionError("no answer");
  assert.ok(connection instanceof NowgateError && !(connection instanceof ApiError));
  assert.equal(connection.name, "ConnectionError");
});
