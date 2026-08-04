import { describe, expect, test } from "vitest";
import { assembleRetrieval, fetchGovernedRetrieval, validateCitations } from "./retrieval";

describe("governed retrieval envelope", () => {
  test("empty inputs → empty allowedCitationIds + empty sources", () => {
    const r = assembleRetrieval({
      approvedKnowledgeReferenceIds: [],
      verifiedLabelIds: [],
      approvedProtocolTemplateIds: [],
      approvedDietTemplateIds: [],
    });
    expect(r.allowedCitationIds.size).toBe(0);
    expect(r.sources.length).toBe(0);
  });

  test("sources include only the four governed types", () => {
    const r = assembleRetrieval({
      approvedKnowledgeReferenceIds: ["kr-1"],
      verifiedLabelIds: ["lbl-2"],
      approvedProtocolTemplateIds: ["pt-3"],
      approvedDietTemplateIds: ["dt-4"],
    });
    expect(r.sources.map((s) => s.type)).toEqual(
      ["knowledge_reference", "product_label", "protocol_template", "diet_template"],
    );
    expect([...r.allowedCitationIds]).toEqual(["kr-1", "lbl-2", "pt-3", "dt-4"]);
  });
});

describe("citation validation — hallucinated citations rejected", () => {
  test("every emitted citation must be in the allowed set", () => {
    const allowed = new Set<string>(["kr-1", "lbl-2"]);
    const { accepted, rejected } = validateCitations(
      [{ refId: "kr-1" }, { refId: "lbl-2" }, { refId: "hallucinated-99" }],
      allowed,
    );
    expect(accepted.map((a) => a.refId)).toEqual(["kr-1", "lbl-2"]);
    expect(rejected).toEqual(["hallucinated-99"]);
  });

  test("empty allowed set rejects everything (governed empty state)", () => {
    const { accepted, rejected } = validateCitations(
      [{ refId: "x" }, { refId: "y" }],
      new Set<string>(),
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual(["x", "y"]);
  });
});

describe("fetchGovernedRetrieval — real RLS-scoped fetch", () => {
  test("invokes fetch_copilot_governed_retrieval with orgId + caller token", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown>; token: string | null | undefined }> = [];
    const fake = async <T,>(fn: string, args: Record<string, unknown>, token?: string | null): Promise<T> => {
      calls.push({ fn, args, token });
      return {
        approvedKnowledgeReferenceIds: [],
        verifiedLabelIds: [],
        approvedProtocolTemplateIds: [],
        approvedDietTemplateIds: [],
      } as unknown as T;
    };
    const envelope = await fetchGovernedRetrieval(
      { organizationId: "org-1", accessToken: "tok-1" },
      fake,
    );
    expect(calls).toEqual([
      { fn: "fetch_copilot_governed_retrieval", args: { _organization_id: "org-1" }, token: "tok-1" },
    ]);
    expect(envelope.allowedCitationIds.size).toBe(0);
    expect(envelope.sources).toEqual([]);
  });

  test("non-empty RPC response is passed through to the envelope", async () => {
    const fake = async <T,>(): Promise<T> =>
      ({
        approvedKnowledgeReferenceIds: ["kr-a"],
        verifiedLabelIds: ["lbl-b"],
        approvedProtocolTemplateIds: ["pt-c"],
        approvedDietTemplateIds: ["dt-d"],
      }) as unknown as T;
    const envelope = await fetchGovernedRetrieval(
      { organizationId: "org-1", accessToken: null },
      fake,
    );
    expect([...envelope.allowedCitationIds]).toEqual(["kr-a", "lbl-b", "pt-c", "dt-d"]);
    expect(envelope.sources.map((s) => s.type)).toEqual([
      "knowledge_reference",
      "product_label",
      "protocol_template",
      "diet_template",
    ]);
  });

  test("empty organizationId is refused before any network call", async () => {
    let called = false;
    const fake = async <T,>(): Promise<T> => {
      called = true;
      return {} as T;
    };
    await expect(
      fetchGovernedRetrieval({ organizationId: "", accessToken: null }, fake),
    ).rejects.toThrow(/organizationId/i);
    expect(called).toBe(false);
  });

  test("RPC error is propagated — no silent fallback to empty", async () => {
    const fake = async <T,>(): Promise<T> => {
      throw new Error("RPC 28000: authentication required");
    };
    await expect(
      fetchGovernedRetrieval({ organizationId: "org-x", accessToken: null }, fake),
    ).rejects.toThrow(/28000/);
  });
});

describe("retrieval — no commercial imports", () => {
  test("this module never reads commercial table names in its query surface", async () => {
    // Import the module SOURCE and grep for commercial identifiers. This is
    // a structural, output-independent check: an empty commercial table would
    // let an output-only assertion pass while proving nothing.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = await fs.promises.readFile(
      path.resolve(process.cwd(), "src/server/copilot/retrieval.ts"),
      "utf-8",
    );
    // Every commercial table name we might accidentally import from.
    const banned = [
      "supplement_products",
      "commercial",
      "affiliate",
      "discount",
      "product_label_commercial_links",
      "protocol_commercial_links",
    ];
    // The "no commercial" JSDoc mentions banned words as prose — strip
    // comments before grepping.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const word of banned) {
      expect(codeOnly.toLowerCase(), `retrieval.ts must not reference ${word}`).not.toContain(word);
    }
  });
});
