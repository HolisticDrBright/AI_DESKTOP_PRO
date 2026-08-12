import { describe, expect, test } from "vitest";
import { buildMinimizedEnvelope } from "./data-minimizer";
import { buildEmptySnapshot } from "./input-builder";
import { assembleRetrieval } from "./retrieval";
import {
  evaluateStagingGate,
  findDirectIdentifiers,
  KILL_SWITCH_DRILL_MAX_AGE_MS,
  STAGING_PROJECT_REF,
  type DatabaseGateVerdict,
  type StagingGateInput,
} from "./staging-gate";

const NOW = 1_800_000_000_000;

function envelope(over: Record<string, unknown> = {}) {
  const base = buildMinimizedEnvelope({
    runType: "practitioner_brief",
    lens: "western",
    ruleSetVersion: "v1",
    promptVersion: "v1",
    outputSchemaVersion: "v1",
    snapshot: buildEmptySnapshot().snapshot,
    retrieval: assembleRetrieval({
      approvedKnowledgeReferenceIds: ["kr-a"],
      verifiedLabelIds: [],
      approvedProtocolTemplateIds: [],
      approvedDietTemplateIds: [],
    }),
  });
  return { ...base, ...over } as typeof base;
}

const DB_ALLOWED: DatabaseGateVerdict = {
  allowed: true,
  refusal: null,
  gates: [],
  environment: "staging",
  approvedUse: "synthetic_staging_verification",
  approvedModel: "gpt-5.6-sol",
  killSwitchEngaged: false,
  callsRemaining: 10,
  tokensRemaining: 50_000,
  costCentsRemaining: 500,
};

function input(over: Partial<StagingGateInput> = {}): StagingGateInput {
  return {
    database: DB_ALLOWED,
    backendUrl: `https://${STAGING_PROJECT_REF}.supabase.co`,
    model: "gpt-5.6-sol",
    envelope: envelope(),
    killSwitchLastTestedAt: NOW - 60_000,
    now: NOW,
    ...over,
  };
}

describe("the happy path is narrow", () => {
  test("all five conditions together authorize a bounded call", () => {
    const v = evaluateStagingGate(input());
    expect(v.allowed).toBe(true);
    if (v.allowed) expect(v.detail).toMatch(/Bounded synthetic staging verification is authorized/);
  });
});

describe("the governed records are the authority and are consulted first", () => {
  test("a database refusal short-circuits every process-side check", () => {
    // Even with a perfect process posture, the row-level verdict decides.
    const v = evaluateStagingGate(
      input({ database: { ...DB_ALLOWED, allowed: false, refusal: "subject_attested_synthetic" } }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.refusal).toBe("governed_records_refused");
      expect(v.detail).toContain("subject_attested_synthetic");
    }
  });

  test("a database refusal wins even when the process side is ALSO broken", () => {
    // The reported refusal must be the authoritative one, not whichever
    // check happens to be cheapest to evaluate.
    const v = evaluateStagingGate(
      input({
        database: { ...DB_ALLOWED, allowed: false, refusal: "kill_switch_clear" },
        backendUrl: "https://someone-elses-project.supabase.co",
      }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.refusal).toBe("governed_records_refused");
  });
});

describe("the process must be pointed at the staging project", () => {
  test("a non-staging backend refuses", () => {
    for (const url of [
      "https://someone-elses-project.supabase.co",
      "https://api.openai.com",
      "http://127.0.0.1:3999",
      "https://prod.example.com",
    ]) {
      const v = evaluateStagingGate(input({ backendUrl: url }));
      expect(v.allowed, url).toBe(false);
      if (!v.allowed) expect(v.refusal).toBe("posture_not_staging_project");
    }
  });

  test("an absent or unparseable backend refuses", () => {
    for (const url of [null, undefined, "", "   ", "not a url"]) {
      const v = evaluateStagingGate(input({ backendUrl: url }));
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.refusal).toBe("backend_not_configured");
    }
  });
});

describe("the model must be governed here as well as approved there", () => {
  test("an activation row naming an ungoverned model still refuses", () => {
    // The row could name something this build cannot price or parameterise.
    const v = evaluateStagingGate(input({ model: "gpt-4o" }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.refusal).toBe("model_not_governed");
  });
});

describe("no direct identifier may leave the process", () => {
  test("a clean minimized envelope carries none", () => {
    expect(findDirectIdentifiers(envelope())).toEqual([]);
  });

  test("an identifier-shaped KEY is caught even if the minimizer let it through", () => {
    const v = evaluateStagingGate(
      input({ envelope: envelope({ mrn: "MRN-12345" }) }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.refusal).toBe("envelope_carries_direct_identifier");
      expect(v.detail).toContain("key:mrn");
      // The refusal names the CATEGORY, never the value.
      expect(v.detail).not.toContain("MRN-12345");
    }
  });

  test("an identifier-shaped VALUE is caught under an innocent key", () => {
    // This is the realistic leak: a free-text field that happens to carry
    // an email or a date of birth. The key tells you nothing.
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ lens: "contact patient@example.com" }, "email address"],
      [{ lens: "call 555-867-5309" }, "us phone number"],
      [{ lens: "ssn 123-45-6789" }, "us ssn"],
      [{ lens: "born 1984-02-29" }, "full date of birth"],
    ];
    for (const [over, label] of cases) {
      const v = evaluateStagingGate(input({ envelope: envelope(over) }));
      expect(v.allowed, label).toBe(false);
      if (!v.allowed) {
        expect(v.refusal).toBe("envelope_carries_direct_identifier");
        expect(v.detail).toContain(`value:${label}`);
      }
    }
  });

  test("the refusal detail never echoes the offending value", () => {
    const v = evaluateStagingGate(
      input({ envelope: envelope({ lens: "patient@example.com and 123-45-6789" }) }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.detail).not.toContain("patient@example.com");
      expect(v.detail).not.toContain("123-45-6789");
    }
  });
});

describe("the kill switch must be known working, not merely present", () => {
  test("a never-tested kill switch refuses", () => {
    const v = evaluateStagingGate(input({ killSwitchLastTestedAt: null }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.refusal).toBe("kill_switch_not_recently_tested");
  });

  test("a stale drill refuses", () => {
    const v = evaluateStagingGate({
      ...input(),
      killSwitchLastTestedAt: NOW - KILL_SWITCH_DRILL_MAX_AGE_MS - 1,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.refusal).toBe("kill_switch_not_recently_tested");
  });

  test("a drill exactly at the boundary still counts", () => {
    const v = evaluateStagingGate({
      ...input(),
      killSwitchLastTestedAt: NOW - KILL_SWITCH_DRILL_MAX_AGE_MS,
    });
    expect(v.allowed).toBe(true);
  });
});

describe("every refusal is PHI-safe", () => {
  test("no refusal detail contains a value from the envelope", () => {
    const dirty = envelope({ mrn: "MRN-999", lens: "leak@example.com" });
    const verdicts = [
      evaluateStagingGate(input({ database: { ...DB_ALLOWED, allowed: false, refusal: "x" }, envelope: dirty })),
      evaluateStagingGate(input({ backendUrl: "https://prod.example.com", envelope: dirty })),
      evaluateStagingGate(input({ model: "gpt-4o", envelope: dirty })),
      evaluateStagingGate(input({ envelope: dirty })),
      evaluateStagingGate(input({ killSwitchLastTestedAt: null })),
    ];
    for (const v of verdicts) {
      expect(v.allowed).toBe(false);
      if (!v.allowed) {
        expect(v.detail).not.toContain("MRN-999");
        expect(v.detail).not.toContain("leak@example.com");
      }
    }
  });
});
