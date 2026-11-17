// The Nowgate client: keys and environments, requests with safe retries and idempotency
// keys, pages, amounts refused as numbers, and problems as errors (api-docs-and-sdks.md,
// sections 1 and 2; ADR 0032).
import type { APIResponse, Requester, RequestOptions, RequestSpec } from "./core.ts";
import { APIPromise } from "./core.ts";
import { type ApiError, apiError, ConnectionError, NowgateError } from "./errors.ts";
import { NowgateResources, VERSION } from "./generated/resources.ts";

/** A transport: the global fetch by default, or a function of your own with its shape. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Your API key: `ngk_live_…` or `ngk_sandbox_…`. */
  apiKey: string;
  /**
   * The API's base URL. It follows the key by default: https://api.nowgate.io/v1 for a live
   * key and https://sandbox-api.nowgate.io/v1 for a sandbox key. Other keys need one.
   */
  baseUrl?: string;
  /** Milliseconds each attempt may take: 60 seconds by default. */
  timeout?: number;
  /** How many times a failed attempt is retried: 2 by default. */
  maxRetries?: number;
  /** The transport, to use an HTTP client of your own: the global fetch by default. */
  fetch?: Fetch;
  /** Your application, added to the User-Agent: `my-shop/1.2`. */
  appInfo?: string;
  /**
   * Run where a `document` exists, such as a test under jsdom. An API key must never reach
   * a browser: call Nowgate from your server.
   */
  dangerouslyAllowBrowser?: boolean;
}

/** The waits between attempts, which the SDK's own tests replace through kHooks. */
export interface Hooks {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
}

/** The SDK's own tests pass Hooks under this key in the client's options. */
export const kHooks = Symbol("nowgate.hooks");

const BASE_URLS: Record<string, string> = {
  live: "https://api.nowgate.io/v1",
  sandbox: "https://sandbox-api.nowgate.io/v1",
};
const KEY = /^ngk_([a-z]+)_([\x21-\x7e]+)$/;
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_RETRIES = 2;
/** The longest Retry-After waited for, in seconds; a longer one is the caller's to handle. */
const MAX_RETRY_AFTER = 60;
const FIRST_BACKOFF = 500;
const MAX_BACKOFF = 8_000;
const RETRIED_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * The Nowgate API's client.
 *
 * ```ts
 * const nowgate = new Nowgate({ apiKey: process.env.NOWGATE_API_KEY });
 * const payment = await nowgate.payments.create({ network: "tron", asset: "USDT", amount: "25" });
 * ```
 */
export class Nowgate extends NowgateResources {
  /** The API's base URL, without a trailing slash. */
  readonly baseUrl: string;
  /** Milliseconds each attempt may take. */
  readonly timeout: number;
  /** How many times a failed attempt is retried. */
  readonly maxRetries: number;
  readonly #transport: Transport;

  constructor(options: ClientOptions) {
    const transport = new Transport(options);
    super(transport);
    this.#transport = transport;
    this.baseUrl = transport.baseUrl;
    this.timeout = transport.timeout;
    this.maxRetries = transport.maxRetries;
  }

  /** The client's settings, with the key shown as the dashboard shows it. */
  toJSON(): Record<string, unknown> {
    return {
      apiKey: this.#transport.keyHint,
      baseUrl: this.baseUrl,
      timeout: this.timeout,
      maxRetries: this.maxRetries,
    };
  }
}

// Node's util.inspect shows the client's settings, with the key hidden.
Object.defineProperty(Nowgate.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value(
    this: Nowgate,
    _depth: number,
    options: object,
    inspect: (value: unknown, options: object) => string,
  ): string {
    return `Nowgate ${inspect(this.toJSON(), options)}`;
  },
});

/** Transport sends the resources' requests. It holds the key, which nothing shows. */
class Transport implements Requester {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  /** The key as the dashboard shows it: its prefix and last four characters. */
  readonly keyHint: string;
  readonly #authorization: string;
  readonly #fetch: Fetch;
  readonly #userAgent: string;
  readonly #hooks: Hooks;

  constructor(options: ClientOptions) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("new Nowgate({ apiKey }) needs its options");
    }
    if (inBrowser() && options.dangerouslyAllowBrowser !== true) {
      throw new NowgateError(
        "Nowgate's SDK runs on servers: an API key must never reach a browser. Call Nowgate from your server.",
      );
    }
    const match = typeof options.apiKey === "string" ? KEY.exec(options.apiKey) : null;
    if (!match) {
      throw new TypeError("apiKey must be a Nowgate API key: ngk_live_… or ngk_sandbox_…");
    }
    const [, env, secret] = match as unknown as [string, string, string];
    this.keyHint = `ngk_${env}_${secret.length >= 16 ? `${secret.slice(0, 6)}…${secret.slice(-4)}` : "…"}`;
    const base = options.baseUrl ?? BASE_URLS[env];
    if (base === undefined) {
      throw new TypeError(`A ${env} key needs a baseUrl: only live and sandbox keys have one`);
    }
    this.baseUrl = baseUrl(base, env);
    this.timeout = milliseconds("timeout", options.timeout ?? DEFAULT_TIMEOUT);
    this.maxRetries = retries(options.maxRetries ?? DEFAULT_MAX_RETRIES);
    const fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetch !== "function") {
      throw new TypeError("This runtime has no fetch: pass a transport as fetch");
    }
    this.#fetch = fetch;
    this.#authorization = `Bearer ${options.apiKey}`;
    this.#userAgent = userAgent(options.appInfo);
    const hooks = (options as { [kHooks]?: Partial<Hooks> })[kHooks];
    this.#hooks = { sleep, random: Math.random, ...hooks };
  }

  request<T>(spec: RequestSpec, options?: RequestOptions): APIPromise<T> {
    return new APIPromise(this.#send<T>(spec, options ?? {}));
  }

  paginate<T>(spec: RequestSpec, options?: RequestOptions): AsyncIterable<T> {
    return this.#walk<T>(spec, options);
  }

  async *#walk<T>(spec: RequestSpec, options: RequestOptions | undefined): AsyncGenerator<T> {
    const query: Record<string, unknown> = { ...spec.query };
    if (query.ending_before !== undefined) {
      throw new TypeError(
        "listAll walks from the newest item down: give starting_after, not ending_before",
      );
    }
    query.limit ??= 100;
    for (;;) {
      const page = await this.request<{ data: T[]; has_more: boolean }>(
        { ...spec, query },
        options,
      );
      yield* page.data;
      const last = page.data.at(-1) as { id?: unknown } | undefined;
      if (!page.has_more || last === undefined) return;
      query.starting_after = last.id;
    }
  }

  async #send<T>(spec: RequestSpec, options: RequestOptions): Promise<APIResponse<T>> {
    const payload = spec.body ?? spec.query;
    if (spec.amounts && payload !== undefined) checkAmounts(payload, spec.amounts);
    const url = this.#url(spec);
    const timeout = milliseconds("timeout", options.timeout ?? this.timeout);
    const maxRetries = retries(options.maxRetries ?? this.maxRetries);
    const headers = new Headers({
      Accept: "application/json",
      Authorization: this.#authorization,
      "User-Agent": this.#userAgent,
    });
    let idempotencyKey: string | undefined;
    if (spec.method === "POST") {
      idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
      if (typeof idempotencyKey !== "string" || idempotencyKey === "") {
        throw new TypeError("idempotencyKey must be a non-empty string, such as a UUID");
      }
      headers.set("Idempotency-Key", idempotencyKey);
    }
    let body: string | undefined;
    if (spec.body !== undefined) {
      body = JSON.stringify(spec.body);
      headers.set("Content-Type", "application/json");
    }
    const init: RequestInit = { method: spec.method, headers, body, redirect: "manual" };

    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted();
      let response: Response;
      let text: string;
      try {
        [response, text] = await this.#attempt(url, init, timeout, options.signal);
      } catch (err) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (attempt >= maxRetries) throw this.#unreachable(err);
        await this.#hooks.sleep(this.#backoff(attempt), options.signal);
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        return {
          data: decode<T>(response, text),
          status: response.status,
          headers: response.headers,
          request_id: response.headers.get("x-request-id") ?? undefined,
          idempotency_key: idempotencyKey,
          idempotent_replayed: response.headers.get("idempotent-replayed") === "true",
        };
      }
      const error = apiError(response.status, response.statusText, response.headers, text);
      if (attempt >= maxRetries || !retryable(error)) throw error;
      let wait = this.#backoff(attempt);
      if (error.retry_after !== undefined) {
        if (error.retry_after > MAX_RETRY_AFTER) throw error;
        wait = error.retry_after * 1000;
      }
      await this.#hooks.sleep(wait, options.signal);
    }
  }

  /** #attempt sends one attempt and reads its answer, within the timeout. */
  async #attempt(
    url: string,
    init: RequestInit,
    timeout: number,
    signal: AbortSignal | undefined,
  ): Promise<[Response, string]> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal });
      return [response, await response.text()];
    } catch (err) {
      if (timedOut) {
        throw new ConnectionError(`Nowgate didn't answer within ${timeout} ms`, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #unreachable(err: unknown): ConnectionError {
    if (err instanceof ConnectionError) return err;
    const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    const why =
      typeof cause === "string" ? cause : err instanceof Error ? err.message : String(err);
    return new ConnectionError(`Couldn't reach Nowgate at ${this.baseUrl}: ${why}`, { cause: err });
  }

  /** #backoff is the wait before retry number attempt+1: exponential, with full jitter. */
  #backoff(attempt: number): number {
    return Math.min(MAX_BACKOFF, FIRST_BACKOFF * 2 ** attempt) * this.#hooks.random();
  }

  #url(spec: RequestSpec): string {
    const path = spec.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const value = spec.pathParams?.[name];
      if (typeof value !== "string" || value === "") {
        throw new TypeError(`${name} must be a non-empty string: an object's ID`);
      }
      return encodeURIComponent(value);
    });
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(spec.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new TypeError(`The query parameter ${name} must be a string, a number or a boolean`);
      }
      query.append(name, String(value));
    }
    const search = query.toString();
    return `${this.baseUrl}${path}${search ? `?${search}` : ""}`;
  }
}

/** retryable says whether the API's answer may change on a retry (ADR 0032). */
function retryable(error: ApiError): boolean {
  if (error.status === 409) return error.code === "idempotency_key_in_progress";
  return RETRIED_STATUSES.has(error.status);
}

function decode<T>(response: Response, text: string): T {
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new NowgateError(`Nowgate answered ${response.status} with a body that isn't JSON`, {
      cause: err,
    });
  }
}

/** checkAmounts refuses numbers where the request has amounts: they are decimal strings. */
function checkAmounts(payload: object, pointers: readonly string[]): void {
  for (const pointer of pointers) visit(payload, pointer.split("/").slice(1), "");
}

function visit(value: unknown, path: string[], at: string): void {
  if (path.length === 0) {
    if (typeof value === "number" || typeof value === "bigint") {
      throw new TypeError(
        `${at} is a ${typeof value}: amounts are decimal strings, such as "12.5"`,
      );
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const [segment, ...rest] = path as [string, ...string[]];
  if (segment === "*") {
    if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) visit(item, rest, `${at}/${i}`);
    }
    return;
  }
  const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
  if (Object.hasOwn(value, key)) {
    visit((value as Record<string, unknown>)[key], rest, `${at}/${segment}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function baseUrl(base: string, env: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new TypeError(`baseUrl isn't a URL: ${base}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("baseUrl must be an https URL");
  }
  if (url.protocol === "http:" && (env === "live" || env === "sandbox")) {
    throw new TypeError(`A ${env} key is sent only over https`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new TypeError("baseUrl can't have a query or a fragment");
  }
  return url.href.replace(/\/+$/, "");
}

function milliseconds(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number of milliseconds`);
  }
  return value;
}

function retries(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("maxRetries must be a whole number, 0 or more");
  }
  return value;
}

function userAgent(appInfo: string | undefined): string {
  const parts = [`nowgate-typescript/${VERSION}`, runtime()];
  if (appInfo !== undefined) {
    if (typeof appInfo !== "string" || !/^[\x21-\x7e]+( [\x21-\x7e]+)*$/.test(appInfo)) {
      throw new TypeError("appInfo must be printable ASCII, such as my-shop/1.2");
    }
    parts.push(appInfo);
  }
  return parts.join(" ");
}

function runtime(): string {
  const g = globalThis as {
    Bun?: { version?: string };
    Deno?: { version?: { deno?: string } };
    process?: { versions?: { node?: string } };
  };
  if (g.Bun?.version) return `bun/${g.Bun.version}`;
  if (g.Deno?.version?.deno) return `deno/${g.Deno.version.deno}`;
  if (g.process?.versions?.node) return `node/${g.process.versions.node}`;
  return "runtime/unknown";
}

function inBrowser(): boolean {
  return typeof (globalThis as { document?: unknown }).document !== "undefined";
}
