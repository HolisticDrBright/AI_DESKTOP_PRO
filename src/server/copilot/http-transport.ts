/**
 * Phase 10B.1 — vendor-neutral HTTP transport for governed copilot calls.
 *
 * SERVER-ONLY. The adapter never calls `fetch` directly; it calls
 * `Transport.send(...)`. Production wires a real transport that:
 *   - only opens sockets to the endpoint the request builder pinned;
 *   - honours the injected AbortSignal;
 *   - never rewrites headers;
 *   - never redirects across origins;
 *   - never logs the body.
 *
 * The unit tests inject a deterministic in-process transport that replays
 * a fixture response. There is no environment variable that can flip the
 * transport at runtime.
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
 * The refusal-only transport shipped in Phase 10B.1. Every call throws.
 * The production transport is authored in Phase 10B.2 after BAA + secret
 * manager wiring pass their independent gates.
 */
export const refusalTransport: Transport = {
  kind: "real",
  async send(_req: TransportRequest): Promise<TransportResponse> {
    throw new Error("openai_transport_refused_in_phase_10b1");
  },
};
