// Webhook verification gives the engine's answers: the 21 published vectors, and the edge
// cases the engine's own tests pin (api-docs-and-sdks.md section 1.7).
import assert from "node:assert/strict";
import { test } from "node:test";
import { NowgateError, SignatureVerificationError, Webhooks } from "../src/index.ts";
import { fixture } from "./fake.ts";

interface Vectors {
  tolerance_seconds: number;
  vectors: Array<{
    name: string;
    secrets: string[];
    body: string;
    header: string;
    now: number;
    valid: boolean;
    error?: string;
  }>;
}

const read = (path: string) => JSON.parse(fixture(path)) as Vectors;
const published = read("api/webhooks/signature-vectors.json");
const edges = read("sdks/testdata/signature-edge-cases.json");

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "valid";
  } catch (err) {
    if (err instanceof SignatureVerificationError) return err.reason;
    throw err;
  }
}

for (const [name, file] of [
  ["published vectors", published],
  ["edge cases", edges],
] as const) {
  test(`verifySignature gives the engine's answer on every one of the ${name}`, async () => {
    assert.ok(file.vectors.length >= (name === "published vectors" ? 21 : 20));
    for (const v of file.vectors) {
      const got = await outcome(() =>
        Webhooks.verifySignature(v.body, v.header, v.secrets, {
          tolerance: file.tolerance_seconds,
          now: v.now,
        }),
      );
      assert.equal(got, v.valid ? "valid" : v.error, v.name);
    }
  });

  test(`constructEvent gives the same answers on the ${name}, from bytes too`, async () => {
    for (const v of file.vectors) {
      const bytes = new TextEncoder().encode(v.body);
      const got = await outcome(() =>
        Webhooks.constructEvent(bytes, v.header, v.secrets, { now: new Date(v.now * 1000) }),
      ).catch((err) => (err instanceof NowgateError ? "valid, not JSON" : Promise.reject(err)));
      const want = v.valid ? (isJSON(v.body) ? "valid" : "valid, not JSON") : v.error;
      assert.equal(got, want, v.name);
    }
  });
}

function isJSON(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const valid = published.vectors[0];
if (!valid?.valid) throw new Error("the first published vector must be valid");

test("constructEvent returns the event, told apart by its type", async () => {
  const event = await Webhooks.constructEvent(valid.body, valid.header, valid.secrets[0] ?? "", {
    now: valid.now,
  });
  assert.equal(event.object, "event");
  assert.equal(event.type, "payment.finished");
  if (event.type === "payment.finished") assert.equal(event.data.object.object, "payment");
});

test("the body may be a string, bytes, a Buffer or an ArrayBuffer; the header a list", async () => {
  const bytes = new TextEncoder().encode(valid.body);
  const at = { now: valid.now };
  for (const body of [
    valid.body,
    bytes,
    Buffer.from(valid.body),
    bytes.buffer,
    new DataView(bytes.buffer),
  ]) {
    await Webhooks.verifySignature(body, valid.header, valid.secrets, at);
  }
  const [t, v1] = valid.header.split(",");
  await Webhooks.verifySignature(valid.body, [t ?? "", v1 ?? ""], valid.secrets, at);
  assert.equal(
    await outcome(() => Webhooks.verifySignature(valid.body, undefined, valid.secrets, at)),
    "malformed",
  );
  assert.equal(
    await outcome(() => Webhooks.verifySignature(valid.body, null, valid.secrets, at)),
    "malformed",
  );
});

test("the tolerance and the time are the caller's to set", async () => {
  const signedAt = Number(/^t=(\d+),/.exec(valid.header)?.[1]);
  const late = { now: signedAt + 3_600 };
  assert.equal(
    await outcome(() => Webhooks.verifySignature(valid.body, valid.header, valid.secrets, late)),
    "timestamp",
  );
  await Webhooks.verifySignature(valid.body, valid.header, valid.secrets, {
    ...late,
    tolerance: 3_600,
  });
  await assert.rejects(
    Webhooks.verifySignature(valid.body, valid.header, valid.secrets, { now: signedAt + 301 }),
    SignatureVerificationError,
  );
  assert.equal(
    await outcome(() => Webhooks.verifySignature(valid.body, valid.header, valid.secrets)),
    "timestamp",
    "now is the clock by default, long after the vector",
  );
});

test("arguments the verifier can't use are TypeErrors, not verification failures", async () => {
  const at = { now: valid.now };
  for (const secrets of ["", [], [""], [valid.secrets[0], 7], undefined]) {
    await assert.rejects(
      Webhooks.verifySignature(valid.body, valid.header, secrets as never, at),
      TypeError,
    );
  }
  await assert.rejects(
    Webhooks.verifySignature({ id: "evt" } as never, valid.header, valid.secrets, at),
    /exactly as received/,
  );
  await assert.rejects(
    Webhooks.verifySignature(valid.body, valid.header, valid.secrets, { now: Number.NaN }),
    /now must be/,
  );
  await assert.rejects(
    Webhooks.verifySignature(valid.body, valid.header, valid.secrets, { ...at, tolerance: -1 }),
    /tolerance/,
  );
});

test("the failure says why, with the vectors' names", async () => {
  await assert.rejects(
    Webhooks.verifySignature(`${valid.body} `, valid.header, valid.secrets, { now: valid.now }),
    (err: unknown) => {
      assert.ok(err instanceof SignatureVerificationError);
      assert.equal(err.reason, "mismatch");
      assert.equal(err.message, "mismatch: no signature matches the body with any of the secrets");
      return true;
    },
  );
});
