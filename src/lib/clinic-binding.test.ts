import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentTabClinicBinding, installClinicBindingFence, resetClinicBindingFenceForTests, setTabClinicBinding } from "./clinic-binding";

// The browser half of the stale-tab fence, with a fictional window and network. No storage is involved.
let network: ReturnType<typeof vi.fn>;
let answerBinding: string | null;
const sentExpected = (index: number) => new Headers((network.mock.calls[index]![1] as RequestInit | undefined)?.headers).get("x-aidp-expected-clinic");

beforeEach(() => {
  resetClinicBindingFenceForTests();
  answerBinding = null;
  network = vi.fn(async () => new Response(JSON.stringify({ data: { ok: true } }), {
    status: 200, headers: answerBinding ? { "x-aidp-clinic-binding": answerBinding } : {},
  }));
  vi.stubGlobal("window", { location: { href: "https://desktop.example.test/patients", origin: "https://desktop.example.test" }, fetch: network });
  installClinicBindingFence();
});
afterEach(() => { vi.unstubAllGlobals(); resetClinicBindingFenceForTests(); });

describe("a tab's clinic binding", () => {
  it("adopts the binding of its first live answer, then sends it on every live call", async () => {
    answerBinding = "v1.clinic-a";
    await window.fetch("/api/live/labs/workspace", { method: "POST", body: "{}" });
    expect(sentExpected(0)).toBeNull();
    expect(currentTabClinicBinding()).toBe("v1.clinic-a");
    await window.fetch("/api/live/tasks/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(sentExpected(1)).toBe("v1.clinic-a");
    expect(new Headers((network.mock.calls[1]![1] as RequestInit).headers).get("content-type")).toBe("application/json");
  });

  it("a server-rendered page's binding is in place before the first call", async () => {
    setTabClinicBinding("v1.rendered");
    answerBinding = "v1.rendered";
    await window.fetch("/api/live/labs/workspace");
    expect(sentExpected(0)).toBe("v1.rendered");
  });

  it("turns an answer produced under another clinic into the clinic-changed refusal instead of showing it", async () => {
    setTabClinicBinding("v1.clinic-a");
    answerBinding = "v1.clinic-b";
    const answer = await window.fetch("/api/live/labs/workspace");
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ error: { code: "conflict", message: "Your clinic changed in another window. Reload to continue." } });
    expect(currentTabClinicBinding()).toBe("v1.clinic-a");
  });

  it("leaves other paths and other origins untouched", async () => {
    setTabClinicBinding("v1.clinic-a");
    await window.fetch("/api/auth/org");
    await window.fetch("https://elsewhere.example.test/api/live/labs/workspace");
    expect(sentExpected(0)).toBeNull();
    expect(sentExpected(1)).toBeNull();
  });

  it("keeps the headers of a Request object and installs only once", async () => {
    setTabClinicBinding("v1.clinic-a");
    const request = new Request("https://desktop.example.test/api/live/labs/workspace", { headers: { "x-fictional": "kept" } });
    installClinicBindingFence();
    await window.fetch(request);
    const headers = new Headers((network.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("x-fictional")).toBe("kept");
    expect(headers.get("x-aidp-expected-clinic")).toBe("v1.clinic-a");
    expect(network).toHaveBeenCalledTimes(1);
  });
});
