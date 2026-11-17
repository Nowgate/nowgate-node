// Webhook signatures, verified exactly as the engine's webhooks/signing.Verify does. The
// published vectors in api/webhooks/signature-vectors.json pin the format:
// Nowgate-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
import { NowgateError, type SignatureFailure, SignatureVerificationError } from "./errors.ts";
import type { WebhookEvent } from "./generated/resources.ts";

/** The body exactly as received, before any JSON parsing: a string or its bytes. */
export type WebhookPayload = string | ArrayBuffer | ArrayBufferView;

/** The Nowgate-Signature header: a Node.js request's header may be a list. */
export type SignatureHeader = string | readonly string[] | null | undefined;

export interface VerifyOptions {
  /** How far the signature's time may be from now, in seconds: 300 by default. */
  tolerance?: number;
  /** The time to verify at, as a Date or in Unix seconds: now by default. */
  now?: Date | number;
}

const DEFAULT_TOLERANCE = 300;
const INT64_MAX = 2n ** 63n - 1n;
// Go's strings.TrimSpace trims Unicode's White_Space characters, these.
const SPACE =
  "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const TRIM = new RegExp(`^${SPACE}+|${SPACE}+$`, "g");
const encoder = new TextEncoder();

/**
 * Checks a webhook's Nowgate-Signature against its raw body. It resolves when the
 * signature's time is within the tolerance and any v1 signature matches any of the
 * secrets (two while you rotate), and rejects with a SignatureVerificationError
 * otherwise. Every comparison takes the same time.
 */
async function verifySignature(
  payload: WebhookPayload,
  header: SignatureHeader,
  secrets: string | readonly string[],
  options: VerifyOptions = {},
): Promise<void> {
  const keys = secretList(secrets);
  const body = bytes(payload);
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new TypeError("tolerance must be a number of seconds, 0 or more");
  }
  const now = seconds(options.now);
  const parsed = parse(typeof header === "string" ? header : (header ?? []).join(","));
  if (typeof parsed === "string") throw new SignatureVerificationError(parsed);
  const age = now - Number(parsed.timestamp);
  if (age > tolerance || age < -tolerance) throw new SignatureVerificationError("timestamp");

  const prefix = encoder.encode(`${parsed.timestamp}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  let ok = false;
  for (const secret of keys) {
    const mac = await hmac(secret, message);
    for (const signature of parsed.signatures) ok = equal(mac, signature) || ok; // no early exit
  }
  if (!ok) throw new SignatureVerificationError("mismatch");
}

/**
 * Checks a webhook's signature as verifySignature does, then returns its event, told
 * apart by its type: `payment.*`, `payout.*`, `refund.*`, `destination.*` or `batch.*`.
 */
async function constructEvent(
  payload: WebhookPayload,
  header: SignatureHeader,
  secrets: string | readonly string[],
  options?: VerifyOptions,
): Promise<WebhookEvent> {
  await verifySignature(payload, header, secrets, options);
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(bytes(payload));
  try {
    return JSON.parse(text) as WebhookEvent;
  } catch (err) {
    throw new NowgateError("The webhook's signature verified, but its body isn't JSON", {
      cause: err,
    });
  }
}

/** Webhook verification. It needs no client, since a webhook handler often has none. */
export const Webhooks = Object.freeze({ verifySignature, constructEvent });

interface Parsed {
  timestamp: bigint;
  signatures: Uint8Array[];
}

/** parse reads the header as signing.parse does, or returns why it can't. */
function parse(header: string): Parsed | SignatureFailure {
  let timestamp: bigint | undefined;
  const signatures: Uint8Array[] = [];
  for (const part of header.split(",")) {
    const item = part.replace(TRIM, "");
    const eq = item.indexOf("=");
    if (eq < 0) return "malformed";
    const key = item.slice(0, eq);
    const value = item.slice(eq + 1);
    if (key === "t") {
      // strconv.ParseInt(value, 10, 64): an optional sign, decimal digits, within int64.
      if (timestamp !== undefined || !/^[+-]?[0-9]+$/.test(value)) return "malformed";
      const n = BigInt(value);
      if (n <= 0n || n > INT64_MAX) return "malformed";
      timestamp = n;
    } else if (key === "v1") {
      if (!/^[0-9a-fA-F]{64}$/.test(value)) return "malformed";
      signatures.push(hex(value));
    } // other schemes are ignored, so new ones can be added
  }
  if (timestamp === undefined) return "malformed";
  if (signatures.length === 0) return "no_signature";
  return { timestamp, signatures };
}

async function hmac(secret: string, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}

/** equal compares two signatures in constant time: it never stops early. */
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (const [i, x] of a.entries()) diff |= x ^ (b[i] ?? 0);
  return diff === 0;
}

function hex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function secretList(secrets: string | readonly string[]): string[] {
  const list = typeof secrets === "string" ? [secrets] : Array.isArray(secrets) ? [...secrets] : [];
  if (list.length === 0 || list.some((s) => typeof s !== "string" || s === "")) {
    throw new TypeError(
      "secrets must be your endpoint's secret (whsec_…), or a list of them while you rotate",
    );
  }
  return list;
}

function bytes(payload: WebhookPayload): Uint8Array {
  if (typeof payload === "string") return encoder.encode(payload);
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  throw new TypeError(
    "Pass the body exactly as received, a string or bytes, before any JSON parsing",
  );
}

function seconds(now: Date | number | undefined): number {
  if (now === undefined) return Date.now() / 1000;
  const value = now instanceof Date ? now.getTime() / 1000 : now;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("now must be a Date or a number of Unix seconds");
  }
  return value;
}
