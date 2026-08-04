import { describe, expect, test } from "vitest";
import { buildEmptySnapshot, buildPatientSnapshot, hashInputSnapshot } from "./input-builder";

describe("input builder — empty and hash", () => {
  test("empty snapshot has every field explicitly null/empty (unknown stays unknown)", () => {
    const { snapshot, records } = buildEmptySnapshot();
    expect(snapshot.demographics).toEqual({
      ageYears: null,
      sex: null,
      isPregnant: null,
      isLactating: null,
      isPediatric: null,
    });
    expect(snapshot.medications).toEqual([]);
    expect(snapshot.allergies).toEqual([]);
    expect(snapshot.labs).toEqual([]);
    expect(snapshot.transcriptRevisions).toEqual([]);
    expect(records).toEqual([]);
  });

  test("hash is deterministic for identical snapshots", () => {
    const a = buildEmptySnapshot();
    const b = buildEmptySnapshot();
    expect(hashInputSnapshot(a.snapshot, a.records)).toBe(hashInputSnapshot(b.snapshot, b.records));
  });

  test("hash changes when a snapshot changes", () => {
    const a = buildEmptySnapshot();
    const b = buildEmptySnapshot();
    b.snapshot.demographics.ageYears = 42;
    expect(hashInputSnapshot(a.snapshot, a.records)).not.toBe(hashInputSnapshot(b.snapshot, b.records));
  });

  test("hash length is a sha256 hex string", () => {
    const { snapshot, records } = buildEmptySnapshot();
    const h = hashInputSnapshot(snapshot, records);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildPatientSnapshot — real RLS-scoped fetch", () => {
  test("invokes build_copilot_input_snapshot with orgId + patientId + caller token", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown>; token: string | null | undefined }> = [];
    const fake = async <T,>(fn: string, args: Record<string, unknown>, token?: string | null): Promise<T> => {
      calls.push({ fn, args, token });
      return {
        snapshot: buildEmptySnapshot().snapshot,
        records: [],
      } as unknown as T;
    };
    const bundle = await buildPatientSnapshot(
      { organizationId: "org-1", patientId: "pt-1", accessToken: "tok-1" },
      fake,
    );
    expect(calls).toEqual([
      { fn: "build_copilot_input_snapshot", args: { _organization_id: "org-1", _patient_id: "pt-1" }, token: "tok-1" },
    ]);
    expect(bundle.snapshot.demographics.ageYears).toBeNull();
    expect(bundle.records).toEqual([]);
  });

  test("returns the RPC's demographics + records verbatim — no local fabrication", async () => {
    const fake = async <T,>(): Promise<T> =>
      ({
        snapshot: {
          demographics: { ageYears: 41, sex: "female", isPregnant: null, isLactating: null, isPediatric: false },
          medications: [{ id: "m1", name: "Test", dose: "10mg", frequency: "daily", status: "active" }],
          allergies: [],
          labs: [],
          currentProtocols: [],
          transcriptRevisions: [],
          interactionReferences: [],
          restrictedFlagsPresent: [],
          sourceStaleness: { lastImportAt: null, lastEncounterAt: null, lastLabAt: null },
          productLabelsInUse: [],
          dosageMentions: [],
        },
        records: [
          {
            inputKind: "medication",
            sourceRefType: "medications",
            sourceRefId: "m1",
            sourceVersion: null,
            effectiveFrom: null,
            effectiveTo: null,
            completeness: "complete",
            hasConflict: false,
            reviewState: "active",
          },
        ],
      }) as unknown as T;
    const bundle = await buildPatientSnapshot(
      { organizationId: "org-1", patientId: "pt-1", accessToken: "tok-1" },
      fake,
    );
    expect(bundle.snapshot.demographics.ageYears).toBe(41);
    expect(bundle.snapshot.medications).toHaveLength(1);
    expect(bundle.records).toHaveLength(1);
  });

  test("empty organizationId / patientId is refused before any network call", async () => {
    let called = false;
    const fake = async <T,>(): Promise<T> => {
      called = true;
      return {} as T;
    };
    await expect(
      buildPatientSnapshot({ organizationId: "", patientId: "pt-1", accessToken: null }, fake),
    ).rejects.toThrow(/organizationId/i);
    await expect(
      buildPatientSnapshot({ organizationId: "org-1", patientId: "", accessToken: null }, fake),
    ).rejects.toThrow(/patientId/i);
    expect(called).toBe(false);
  });

  test("unexpected RPC shape → throws (never falls back to empty)", async () => {
    const fake = async <T,>(): Promise<T> => ({} as T);
    await expect(
      buildPatientSnapshot({ organizationId: "org-1", patientId: "pt-1", accessToken: null }, fake),
    ).rejects.toThrow(/unexpected shape/i);
  });

  test("RPC error is propagated — no silent fallback to buildEmptySnapshot", async () => {
    const fake = async <T,>(): Promise<T> => {
      throw new Error("RPC 42501: not a member of this organization");
    };
    await expect(
      buildPatientSnapshot({ organizationId: "org-x", patientId: "pt-x", accessToken: "tok" }, fake),
    ).rejects.toThrow(/42501/);
  });
});
