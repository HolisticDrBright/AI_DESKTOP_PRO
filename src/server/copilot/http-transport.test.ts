import { describe, expect, test, vi } from "vitest";
import {
  createHttpsTransport,
  refusalTransport,
  TransportError,
  type TransportRequest,
} from "./http-transport";

const OPENAI = "https://api.openai.com";
const ENDPOINT = new URL("https://api.openai.com/v1/responses");

function jsonResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function req(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    endpoint: ENDPOINT,
    method: "POST",
    headers: { Authorization: "Bearer TEST_FAKE_BEARER_abcdefghijklmnop" },
    body: { hello: "world" },
    ...overrides,
  };
}

describe("refusalTransport", () => {
  test("is the fail-closed default and never returns a response", async () => {
    await expect(refusalTransport.send(req())).rejects.toThrow(/refused_by_default/);
  });
});

describe("createHttpsTransport — construction", () => {
  test("refuses an empty allowlist", () => {
    expect(() => createHttpsTransport({ allowedOrigins: [] })).toThrow(/allowlist_empty/);
  });

  test("refuses a non-https origin in the allowlist", () => {
    expect(() => createHttpsTransport({ allowedOrigins: ["http://api.openai.com"] })).toThrow(
      /allowlist_not_https/,
    );
  });
});

describe("createHttpsTransport — origin pinning", () => {
  test("sends to an allowlisted origin", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"ok":true}'));
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl: fetchImpl as never });
    const res = await t.send(req());
    expect(res.status).toBe(200);
    expect(res.bodyText).toBe('{"ok":true}');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("refuses an off-allowlist origin without opening a socket", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("{}"));
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl: fetchImpl as never });
    await expect(
      t.send(req({ endpoint: new URL("https://evil.example/v1/responses") })),
    ).rejects.toMatchObject({ category: "transport_origin_refused" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a lookalike suffix host is refused — origin equality, not substring", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("{}"));
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl: fetchImpl as never });
    for (const host of [
      "https://api.openai.com.evil.example/v1/responses",
      "https://notapi.openai.com/v1/responses",
      "https://api.openai.com:8443/v1/responses",
    ]) {
      await expect(t.send(req({ endpoint: new URL(host) }))).rejects.toMatchObject({
        category: "transport_origin_refused",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("refuses a non-https scheme", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("{}"));
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl: fetchImpl as never });
    await expect(
      t.send(req({ endpoint: new URL("http://api.openai.com/v1/responses") })),
    ).rejects.toMatchObject({ category: "transport_scheme_refused" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createHttpsTransport — redirects", () => {
  test("requests manual redirect handling", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse("{}"));
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl });
    await t.send(req());
    expect(fetchImpl.mock.calls[0]![1]!.redirect).toBe("manual");
  });

  test("refuses a 3xx rather than following it", async () => {
    // Following a redirect would carry the Authorization header to a host
    // the allowlist never approved.
    const fetchImpl = vi.fn(
      async () =>
        new Response("", { status: 302, headers: { location: "https://evil.example" } }),
    );
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl: fetchImpl as never });
    await expect(t.send(req())).rejects.toMatchObject({
      category: "transport_redirect_refused",
    });
  });
});

describe("createHttpsTransport — bounds", () => {
  test("refuses an oversized request before sending", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("{}"));
    const t = createHttpsTransport({
      allowedOrigins: [OPENAI],
      maxRequestBytes: 100,
      fetchImpl: fetchImpl as never,
    });
    await expect(t.send(req({ body: { big: "x".repeat(500) } }))).rejects.toMatchObject({
      category: "transport_request_too_large",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("refuses an oversized response declared by content-length", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse("{}", { headers: { "content-length": "999999" } }),
    );
    const t = createHttpsTransport({
      allowedOrigins: [OPENAI],
      maxResponseBytes: 1000,
      fetchImpl: fetchImpl as never,
    });
    await expect(t.send(req())).rejects.toMatchObject({
      category: "transport_response_too_large",
    });
  });

  test("refuses a response that exceeds the ceiling while streaming", async () => {
    // content-length is a claim by the peer; the real bound is enforced
    // against bytes actually received.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 20; i += 1) {
          controller.enqueue(new TextEncoder().encode("x".repeat(100)));
        }
        controller.close();
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const t = createHttpsTransport({
      allowedOrigins: [OPENAI],
      maxResponseBytes: 500,
      fetchImpl: fetchImpl as never,
    });
    await expect(t.send(req())).rejects.toMatchObject({
      category: "transport_response_too_large",
    });
  });
});

describe("createHttpsTransport — status and content type", () => {
  test("refuses a 200 that is not JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html>captive portal</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl: fetchImpl as never });
    await expect(t.send(req())).rejects.toMatchObject({
      category: "transport_content_type_invalid",
    });
  });

  test("accepts a +json content type", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"ok":1}', {
          status: 200,
          headers: { "content-type": "application/vnd.openai+json; charset=utf-8" },
        }),
    );
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl: fetchImpl as never });
    await expect(t.send(req())).resolves.toMatchObject({ status: 200 });
  });

  test("returns a non-2xx to the caller so the retry classifier can read it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 }),
    );
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl: fetchImpl as never });
    const res = await t.send(req());
    expect(res.status).toBe(429);
    expect(res.bodyText).toContain("rate_limit_exceeded");
  });
});

describe("createHttpsTransport — cancellation and timeout", () => {
  test("honours an already-aborted caller signal without fetching", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("{}"));
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl: fetchImpl as never });
    const ac = new AbortController();
    ac.abort();
    await expect(t.send(req({ signal: ac.signal }))).rejects.toMatchObject({
      category: "transport_cancelled",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("passes an AbortSignal to fetch and reports a timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      // Never resolves on its own — only the transport's own timeout ends it.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], timeoutMs: 25, fetchImpl });
    await expect(t.send(req())).rejects.toMatchObject({ category: "transport_timeout" });
    expect(fetchImpl.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("createHttpsTransport — leakage", () => {
  test("a network failure category carries no URL, header, or body", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 10.1.2.3:443 internal-proxy.corp");
    });
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl: fetchImpl as never });
    const err = (await t.send(req()).catch((e) => e)) as TransportError;
    expect(err).toBeInstanceOf(TransportError);
    expect(err.category).toBe("transport_network");
    expect(err.message).toBe("transport_network");
    expect(err.message).not.toContain("10.1.2.3");
    expect(err.message).not.toContain("internal-proxy");
  });

  test("only allowlisted operational response headers are surfaced", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse("{}", {
        headers: {
          "set-cookie": "session=SHOULD_NOT_APPEAR",
          "x-request-id": "req_123",
          "retry-after": "3",
        },
      }),
    );
    const t = createHttpsTransport({ allowedOrigins: [OPENAI], fetchImpl: fetchImpl as never });
    const res = await t.send(req());
    expect(res.headers["x-request-id"]).toBe("req_123");
    expect(res.headers["retry-after"]).toBe("3");
    expect(JSON.stringify(res.headers)).not.toContain("SHOULD_NOT_APPEAR");
  });
});
