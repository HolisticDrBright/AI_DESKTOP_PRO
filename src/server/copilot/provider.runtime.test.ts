import { describe, expect, test, vi } from "vitest";
import { createOpenAITransport, resolveProviderRuntime } from "./provider.runtime";
import type { SecretResolver } from "./secrets";
import type { Transport } from "./http-transport";

const fakeResolver = () => ({ size: () => 0 }) as unknown as SecretResolver;
const fakeTransport = (): Transport => ({
  kind: "fake",
  async send() {
    throw new Error("not used");
  },
});

describe("resolveProviderRuntime — disabled constructs nothing", () => {
  test("disabled mode returns before a secret resolver is constructed", () => {
    const makeSecretResolver = vi.fn(fakeResolver);
    const makeTransport = vi.fn(fakeTransport);
    const rt = resolveProviderRuntime({ mode: "disabled", makeSecretResolver, makeTransport });
    expect(rt).toEqual({ kind: "disabled", refusal: "copilot_disabled" });
    // This is the whole point of the module: not "the resolver refuses",
    // but "the resolver was never built", so no AWS client exists and no
    // credential was ever read.
    expect(makeSecretResolver).not.toHaveBeenCalled();
    expect(makeTransport).not.toHaveBeenCalled();
  });

  test("disabled mode constructs no transport either", () => {
    const makeTransport = vi.fn(fakeTransport);
    resolveProviderRuntime({ mode: "disabled", makeTransport, makeSecretResolver: fakeResolver });
    expect(makeTransport).not.toHaveBeenCalled();
  });

  test("fixture mode also constructs no resolver and no transport", () => {
    const makeSecretResolver = vi.fn(fakeResolver);
    const makeTransport = vi.fn(fakeTransport);
    const rt = resolveProviderRuntime({ mode: "fixture", makeSecretResolver, makeTransport });
    expect(rt).toEqual({ kind: "fixture", refusal: "fixture_mode" });
    expect(makeSecretResolver).not.toHaveBeenCalled();
    expect(makeTransport).not.toHaveBeenCalled();
  });
});

describe("resolveProviderRuntime — live", () => {
  test("live with no secret backend is live_unconfigured and builds no transport", () => {
    const makeTransport = vi.fn(fakeTransport);
    const rt = resolveProviderRuntime({
      mode: "live",
      makeSecretResolver: () => null,
      makeTransport,
    });
    expect(rt).toEqual({ kind: "live_unconfigured", refusal: "secret_backend_unconfigured" });
    // It does NOT fall back to a key from the environment, and does NOT
    // fall back to the fixture provider.
    expect(makeTransport).not.toHaveBeenCalled();
  });

  test("live with a secret backend builds exactly one transport and one resolver", () => {
    const makeSecretResolver = vi.fn(fakeResolver);
    const makeTransport = vi.fn(fakeTransport);
    const rt = resolveProviderRuntime({ mode: "live", makeSecretResolver, makeTransport });
    expect(rt.kind).toBe("live");
    expect(makeSecretResolver).toHaveBeenCalledTimes(1);
    expect(makeTransport).toHaveBeenCalledTimes(1);
  });

  test("the secret backend is consulted before a transport is built", () => {
    const order: string[] = [];
    resolveProviderRuntime({
      mode: "live",
      makeSecretResolver: () => {
        order.push("secret");
        return fakeResolver();
      },
      makeTransport: () => {
        order.push("transport");
        return fakeTransport();
      },
    });
    expect(order).toEqual(["secret", "transport"]);
  });
});

describe("createOpenAITransport", () => {
  test("is pinned to the official OpenAI origin", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } }),
    );
    const t = createOpenAITransport(fetchImpl as never);
    await expect(
      t.send({
        endpoint: new URL("https://api.example.com/v1/responses"),
        method: "POST",
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ category: "transport_origin_refused" });
    expect(fetchImpl).not.toHaveBeenCalled();

    await t.send({
      endpoint: new URL("https://api.openai.com/v1/responses"),
      method: "POST",
      headers: {},
      body: {},
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("makes zero external requests when nothing calls send()", () => {
    const fetchImpl = vi.fn();
    createOpenAITransport(fetchImpl as never);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
