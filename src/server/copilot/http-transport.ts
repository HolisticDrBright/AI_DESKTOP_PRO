/**
 * Phase 10B.1 — vendor-neutral HTTP transport for governed copilot calls.
 *
 * SERVER-ONLY. The adapter never calls `fetch` directly; it calls
 * `Transport.send(...)`. Two implementations live here:
 *
 *   - `refusalTransport` — the DEFAULT. Every `send()` throws. An adapter
 *     that was handed no explicit transport can never reach a socket.
 *   - `createHttpsTransport(...)` — the real bounded HTTPS transport. It
 *     opens sockets ONLY to an origin on its construction-time allowlist,
 *     refuses redirects, enforces a hard `AbortSignal` timeout, bounds both
 *     the request and the response in bytes, and validates HTTP status and
 *     content type before anyone parses the body.
 *
 * The allowlist is fixed at construction by the caller that owns the
 * endpoint contract (`provider.openai.request.ts` pins the OpenAI origin,
 * `secrets.aws.ts` pins the regional Secrets Manager origin). There is no
 * environment variable that widens it, and a caller-supplied base URL is
 * refused rather than trusted.
 *
 * Logging discipline: this module never logs a URL with a query string, a
 * header, a request body, or a response body. Failures carry a PHI-safe
 * category only.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/http-transport is server-only.");
}

export type TransportRequest = {
  endpoint: URL;
  method: "POST";
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
};

export type TransportResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyText: string;
};

export type Transport = {
  readonly kind: "fake" | "real";
  send(req: TransportRequest): Promise<TransportResponse>;
};

/**
 * PHI-safe transport failure categories. None of these carries provider
 * prose, prompt text, chart content, or secret material.
 */
export type TransportFailureCategory =
  | "transport_origin_refused"
  | "transport_scheme_refused"
  | "transport_redirect_refused"
  | "transport_request_too_large"
  | "transport_response_too_large"
  | "transport_content_type_invalid"
  | "transport_timeout"
  | "transport_cancelled"
  | "transport_network";

export class TransportError extends Error {
  readonly category: TransportFailureCategory;
  readonly httpStatus?: number;
  constructor(category: TransportFailureCategory, httpStatus?: number) {
    // The message IS the category — there is deliberately no interpolated
    // detail, because every available detail at this layer is either a URL,
    // a header, or a body.
    super(category);
    this.name = "TransportError";
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

/**
 * The refusal-only transport. This is the default everywhere: an adapter
 * constructed without an explicit transport cannot make a request, so
 * "forgot to wire the gate" fails closed rather than open.
 */
export const refusalTransport: Transport = {
  kind: "real",
  async send(_req: TransportRequest): Promise<TransportResponse> {
    throw new Error("openai_transport_refused_by_default");
  },
};

export type HttpsTransportOptions = {
  /**
   * Exact origins this transport may open a socket to, e.g.
   * `https://api.openai.com`. Compared with `URL.origin` equality — never a
   * prefix, substring, or suffix match, because `https://api.openai.com.evil`
   * passes all three.
   */
  allowedOrigins: readonly string[];
  /** Hard wall-clock ceiling per attempt. Enforced with AbortSignal. */
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /** Injected for tests. Production passes the platform `fetch`. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024; // 256 KiB
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB

/**
 * Content types we are willing to parse. A provider that answers a JSON
 * endpoint with `text/html` is an interception or an error page, not a
 * response — refuse before parsing rather than after.
 */
const JSON_CONTENT_TYPES = ["application/json", "application/x-amz-json-1.1"];

function isJsonContentType(raw: string | null): boolean {
  if (!raw) return false;
  const base = raw.split(";")[0]!.trim().toLowerCase();
  return JSON_CONTENT_TYPES.includes(base) || base.endsWith("+json");
}

/**
 * Build a real HTTPS transport bound to a fixed origin allowlist.
 *
 * Every guarantee below is enforced here rather than trusted from the
 * caller, because the caller is the thing most likely to be wrong:
 *
 *   - https only, and only to an allowlisted origin;
 *   - `redirect: "manual"` — a 3xx is a refusal, never a followed hop, so a
 *     redirect cannot move an authorization header to another host;
 *   - a hard timeout that composes with any caller-supplied signal;
 *   - bounded serialized request size and bounded streamed response size,
 *     so a hostile or broken peer cannot exhaust memory;
 *   - status and content-type validated before the body is parsed.
 */
export function createHttpsTransport(options: HttpsTransportOptions): Transport {
  const allowed = new Set(options.allowedOrigins);
  if (allowed.size === 0) {
    throw new Error("transport_allowlist_empty");
  }
  for (const origin of allowed) {
    if (!origin.startsWith("https://")) {
      throw new Error("transport_allowlist_not_https");
    }
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("transport_fetch_unavailable");
  }

  return {
    kind: "real",
    async send(req: TransportRequest): Promise<TransportResponse> {
      if (req.endpoint.protocol !== "https:") {
        throw new TransportError("transport_scheme_refused");
      }
      if (!allowed.has(req.endpoint.origin)) {
        // A caller-provided base URL never becomes trusted by being passed
        // in. This is the check that makes "no arbitrary base URL" true.
        throw new TransportError("transport_origin_refused");
      }

      const serialized =
        typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
      const requestBytes = Buffer.byteLength(serialized, "utf8");
      if (requestBytes > maxRequestBytes) {
        throw new TransportError("transport_request_too_large");
      }

      // Compose our hard timeout with any signal the caller already owns.
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
      const onCallerAbort = () => timeoutController.abort();
      if (req.signal) {
        if (req.signal.aborted) {
          clearTimeout(timer);
          throw new TransportError("transport_cancelled");
        }
        req.signal.addEventListener("abort", onCallerAbort, { once: true });
      }

      try {
        let res: Response;
        try {
          res = await doFetch(req.endpoint.toString(), {
            method: req.method,
            headers: req.headers,
            body: serialized,
            signal: timeoutController.signal,
            redirect: "manual",
          });
        } catch (err) {
          if (req.signal?.aborted) throw new TransportError("transport_cancelled");
          if (timeoutController.signal.aborted) throw new TransportError("transport_timeout");
          // Network-layer failure: DNS, TLS, connection reset. The
          // underlying message may name an internal host, so it is dropped.
          void err;
          throw new TransportError("transport_network");
        }

        // A redirect is refused, never followed. Following one would move
        // the Authorization header to a host the allowlist never approved.
        if (res.status >= 300 && res.status < 400) {
          throw new TransportError("transport_redirect_refused", res.status);
        }

        const bodyText = await readBounded(res, maxResponseBytes);

        // Content type is validated on success responses before anything
        // parses them. Error responses are returned as-is so the adapter's
        // classifier can read the provider's error code, still bounded.
        if (res.status >= 200 && res.status < 300) {
          if (!isJsonContentType(res.headers.get("content-type"))) {
            throw new TransportError("transport_content_type_invalid", res.status);
          }
        }

        return {
          status: res.status,
          statusText: res.statusText,
          headers: collectSafeHeaders(res.headers),
          bodyText,
        };
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

/**
 * Stream the body with a running byte ceiling. `Content-Length` is a claim
 * by the peer, so it is used as an early reject only — the real bound is
 * enforced against bytes actually received.
 */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new TransportError("transport_response_too_large", res.status);
  }
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new TransportError("transport_response_too_large", res.status);
      }
      chunks.push(value);
    }
  } finally {
    // Release the socket whether we finished or bailed at the ceiling.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Only operational headers are surfaced. Nothing that could carry a token,
 * a cookie, or a provider-side identifier tied to content is copied out.
 */
const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "retry-after",
  "x-request-id",
  "x-amzn-requestid",
  "x-amzn-errortype",
];

function collectSafeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const v = headers.get(name);
    if (v != null) out[name] = v;
  }
  return out;
}
