// What the generated resources build on: a request's description, a call's options, and
// the promise every call returns, which can also give the answer alongside its data.

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One call of an operation, as the generated resources describe it. */
export interface RequestSpec {
  method: HttpMethod;
  /** The path under the base URL, with {name} for each path parameter. */
  path: string;
  pathParams?: Record<string, unknown>;
  query?: object | undefined;
  body?: object | undefined;
  /** JSON pointers to the amounts in the body or the query; a "*" segment is every item of an array. */
  amounts?: readonly string[];
}

/** Options for one call, after its arguments. */
export interface RequestOptions {
  /**
   * A POST's idempotency key: a random UUID by default, the same for every attempt of the
   * call. Pass your own to make a retry safe across your own process's restarts.
   */
  idempotencyKey?: string;
  /** Milliseconds each attempt may take (the client's, 60 seconds by default). */
  timeout?: number;
  /** How many times a failed attempt is retried (the client's, 2 by default). */
  maxRetries?: number;
  /** Cancels the call, and any wait before its next attempt. */
  signal?: AbortSignal;
}

/** The answer alongside its data, from a call's `.withResponse()`. */
export interface APIResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  /** The request's ID (`X-Request-Id`), to quote to support. */
  request_id: string | undefined;
  /** The idempotency key a POST was sent with. */
  idempotency_key: string | undefined;
  /** The API replayed the answer it stored for this key: the call had already been made. */
  idempotent_replayed: boolean;
}

/** What the resources call: the client's requests and pages. */
export interface Requester {
  request<T>(spec: RequestSpec, options?: RequestOptions): APIPromise<T>;
  paginate<T>(spec: RequestSpec, options?: RequestOptions): AsyncIterable<T>;
}

/** A group of operations, such as `payments`. */
export class APIResource {
  protected readonly _client: Requester;

  constructor(client: Requester) {
    this._client = client;
  }
}

/**
 * The promise a call returns. It resolves to the data, as the API sent it; its
 * `withResponse()` resolves to the data with the status, the headers, the request's ID
 * and its idempotency facts.
 */
export class APIPromise<T> extends Promise<T> {
  readonly #response: Promise<APIResponse<T>>;

  constructor(response: Promise<APIResponse<T>>) {
    // The base promise is never read: then() reads the response instead, so a failed call
    // rejects only the promises its caller holds.
    super((resolve) => resolve(undefined as T));
    this.#response = response;
  }

  /** The data with the status, the headers, `request_id` and the idempotency facts. */
  withResponse(): Promise<APIResponse<T>> {
    return this.#response;
  }

  // A rejection's reason is typed `any`, as on every Promise, so handlers type the same.
  // biome-ignore lint/suspicious/noThenProperty: a call's promise resolves to its data
  override then<A = T, B = never>(
    onfulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    // biome-ignore lint/suspicious/noExplicitAny: Promise's own signature
    onrejected?: ((reason: any) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.#response.then((r) => r.data).then(onfulfilled, onrejected);
  }

  override catch<B = never>(
    // biome-ignore lint/suspicious/noExplicitAny: Promise's own signature
    onrejected?: ((reason: any) => B | PromiseLike<B>) | null,
  ): Promise<T | B> {
    return this.then(undefined, onrejected);
  }

  override finally(onfinally?: (() => void) | null): Promise<T> {
    return this.then().finally(onfinally);
  }
}
