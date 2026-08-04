import { describe, expect, test } from "vitest";
import { buildEmptySnapshot, hashInputSnapshot } from "./input-builder";

describe("input builder", () => {
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
