import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { describeRuntimePosture } from "./posture";

const KEYS = [
  "CLINICAL_SUPABASE_URL",
  "APP_EDITION",
  "NEXT_PUBLIC_USE_LIVE_API",
  "NODE_ENV",
] as const;

function reset() {
  for (const k of KEYS) delete process.env[k];
}

describe("runtime posture — PHI-safe fields only", () => {
  beforeEach(reset);
  afterEach(reset);

  test("real Supabase URL emits transport=postgrest and extracts project ref", () => {
    process.env.CLINICAL_SUPABASE_URL = "https://urcjiehlxoehievobezf.supabase.co";
    process.env.APP_EDITION = "clinical";
    process.env.NEXT_PUBLIC_USE_LIVE_API = "true";
    const p = describeRuntimePosture();
    expect(p.transport).toBe("postgrest");
    expect(p.supabase_project_ref).toBe("urcjiehlxoehievobezf");
    expect(p.supabase_host).toBe("urcjiehlxoehievobezf.supabase.co");
    expect(p.app_edition).toBe("clinical");
    expect(p.live_mode).toBe(true);
  });

  test("localhost URL emits transport=fixture", () => {
    process.env.CLINICAL_SUPABASE_URL = "http://127.0.0.1:3999";
    const p = describeRuntimePosture();
    expect(p.transport).toBe("fixture");
    expect(p.supabase_project_ref).toBeNull();
  });

  test("stub-server URL on port 3999 is treated as fixture", () => {
    process.env.CLINICAL_SUPABASE_URL = "http://mystub.local:3999";
    const p = describeRuntimePosture();
    expect(p.transport).toBe("fixture");
  });

  test("missing URL emits unknown transport, null host, null ref", () => {
    const p = describeRuntimePosture();
    expect(p.transport).toBe("unknown");
    expect(p.supabase_host).toBeNull();
    expect(p.supabase_project_ref).toBeNull();
  });

  test("malformed URL emits unknown transport without throwing", () => {
    process.env.CLINICAL_SUPABASE_URL = "not a url";
    const p = describeRuntimePosture();
    expect(p.transport).toBe("unknown");
  });

  test("live_mode false when NEXT_PUBLIC_USE_LIVE_API is not exactly 'true'", () => {
    process.env.NEXT_PUBLIC_USE_LIVE_API = "1";
    expect(describeRuntimePosture().live_mode).toBe(false);
    process.env.NEXT_PUBLIC_USE_LIVE_API = "yes";
    expect(describeRuntimePosture().live_mode).toBe(false);
  });

  test("emitted object carries no key material or credential fields", () => {
    process.env.CLINICAL_SUPABASE_URL = "https://foo.supabase.co";
    process.env.CLINICAL_SUPABASE_ANON_KEY = "eyJfake.anon.key";
    const p = describeRuntimePosture();
    const json = JSON.stringify(p);
    expect(json).not.toContain("eyJfake");
    expect(json).not.toContain("anon_key");
    expect(json).not.toContain("service_role");
    expect(json).not.toContain("Bearer");
    expect(json).not.toContain("cookie");
  });
});
