// A fake transport for the unit tests: it answers each request from a script, records what
// it was sent, and the client's waits between attempts are recorded instead of slept.

import { existsSync, readFileSync } from "node:fs";
import { type ClientOptions, kHooks, Nowgate } from "../src/client.ts";

/**
 * A file the SDKs' tests share (the published vectors, the spec, the operations' names),
 * by its path in Nowgate's repository: from this SDK's testdata/ when the SDK stands
 * alone, as in its public repository, else from the repository's own path.
 */
export function fixture(path: string): string {
  const local = new URL(`../testdata/${path.split("/").pop()}`, import.meta.url);
  return readFileSync(
    existsSync(local) ? local : new URL(`../../../${path}`, import.meta.url),
    "utf8",
  );
}

/** A test key: low-entropy, so no secret scanner mistakes it for a real one. */
export const SECRET = `${"0123456789".repeat(4)}abc`;
export const KEY = `ngk_sandbox_${SECRET}`;

export interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

/** An answer: a response, an error to throw (no response), or a function of the request. */
export type Answer = Response | Error | ((sent: Sent) => Response | Promise<Response>);

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** problem answers with RFC 9457 problem JSON, as the API does. */
export function problem(
  status: number,
  code: string,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Response {
  const body = {
    type: `https://docs.nowgate.io/errors/${code}`,
    title: "Problem",
    status,
    code,
    detail: `The ${code} detail.`,
    instance: "/v1/payments",
    request_id: "req_problem",
    ...extra,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json", ...headers },
  });
}

/** refused is what fetch throws when nothing listens. */
export function refused(): Error {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
    code: "ECONNREFUSED",
  });
  return new TypeError("fetch failed", { cause });
}

export function fake(
  answers: Answer[],
  options: Partial<ClientOptions> = {},
  random = () => 1,
): { nowgate: Nowgate; sent: Sent[]; waits: number[] } {
  const sent: Sent[] = [];
  const waits: number[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const request: Sent = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : undefined,
      signal: init.signal ?? undefined,
    };
    sent.push(request);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected request: ${request.method} ${url}`);
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(request) : answer;
  };
  const hooks = {
    sleep: async (ms: number, signal?: AbortSignal) => {
      waits.push(ms);
      if (signal?.aborted) throw signal.reason;
    },
    random,
  };
  const nowgate = new Nowgate({ apiKey: KEY, fetch, ...options, [kHooks]: hooks } as ClientOptions);
  return { nowgate, sent, waits };
}

export const PAYMENT = {
  id: "pay_01m6k00000000000000000000a",
  object: "payment",
  status: "waiting",
  network: "tron",
  asset: "USDT",
  amount: "25",
};
