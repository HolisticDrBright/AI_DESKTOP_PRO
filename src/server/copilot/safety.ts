/**
 * Phase 10A — deterministic invariant safety core.
 *
 * SERVER-ONLY. Runs BEFORE and AFTER any model-assisted step. Does NOT
 * receive the selected paradigm/lens as an input — safety is lens-agnostic.
 *
 * The core carries forward the existing invariant-lens architecture: each
 * check is deterministic, PHI-safe in its label, and produces a pinned
 * safety item that no lens may re-rank or hide.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/safety is server-only.");
}

export type SafetyCategory =
  | "emergency_symptom"
  | "chest_pain"
  | "stroke_symptom"
  | "suicidality"
  | "critical_lab"
  | "pregnancy"
  | "lactation"
  | "pediatrics"
  | "medication_allergy"
  | "duplicate_ingredient"
  | "known_contraindication"
  | "renal_limitation"
  | "hepatic_limitation"
  | "conflicting_chart_info"
  | "missing_demographics"
  | "missing_medication_review"
  | "missing_allergy_review"
  | "missing_interaction_reference"
  | "unverified_product_label"
  | "missing_dosage_source"
  | "restricted_or_jurisdictional_content"
  | "prompt_injection_detected"
  | "stale_evidence"
  | "stale_patient_input";

export type SafetyItem = {
  category: SafetyCategory;
  severity: "urgent" | "important" | "info";
  message: string;
  pinned: boolean; // urgent items stay pinned + identical under every lens
  patientSourceRef?: string;
  governedSourceRef?: string;
};

/**
 * Everything the safety core consumes. All fields are pre-verified.
 * Absence stays as absence — no field is inferred.
 */
export type CopilotInputSnapshot = {
  demographics: {
    ageYears: number | null;
    sex: string | null;
    isPregnant: boolean | null;
    isLactating: boolean | null;
    isPediatric: boolean | null;
  };
  medications: Array<{ name: string; ingredients: string[]; source: "verified" | "unverified" }>;
  allergies: Array<{ substance: string }>;
  labs: Array<{
    code: string;
    value: number | null;
    unit: string | null;
    referenceLow: number | null;
    referenceHigh: number | null;
    criticalLow: number | null;
    criticalHigh: number | null;
    observedAt: string;
  }>;
  currentProtocols: Array<{ id: string; ingredients: string[]; contraindications: string[] }>;
  transcriptRevisions: Array<{ id: string; content: string }>;
  interactionReferences: Array<{ id: string; version: string | null }>;
  restrictedFlagsPresent: string[];
  sourceStaleness: {
    lastImportAt: string | null;
    lastEncounterAt: string | null;
    lastLabAt: string | null;
  };
  productLabelsInUse: Array<{ id: string; status: "verified" | "pending" | "unverified" }>;
  dosageMentions: Array<{
    productId: string | null;
    approvedProtocolSourceId: string | null;
    verifiedLabelId: string | null;
    text: string;
  }>;
};

/**
 * The deterministic core. Every check is idempotent and pure over its
 * input snapshot. NO lens argument.
 */
export function runSafetyCore(input: CopilotInputSnapshot): SafetyItem[] {
  const items: SafetyItem[] = [];

  // ------------------------------------------------- emergency / urgent
  for (const t of input.transcriptRevisions) {
    const text = t.content.toLowerCase();
    if (/crushing chest pain|substernal (chest )?pressure/.test(text)) {
      items.push({
        category: "chest_pain",
        severity: "urgent",
        message: "Reported chest-pain wording in transcript — evaluate immediately.",
        pinned: true,
        patientSourceRef: t.id,
      });
    }
    if (/facial droop|arm weakness|slurred speech|sudden numbness/.test(text)) {
      items.push({
        category: "stroke_symptom",
        severity: "urgent",
        message: "Stroke-warning wording in transcript — evaluate immediately.",
        pinned: true,
        patientSourceRef: t.id,
      });
    }
    if (/suicidal|self[- ]harm|end my life|kill myself/.test(text)) {
      items.push({
        category: "suicidality",
        severity: "urgent",
        message: "Suicidality wording in transcript — follow the org's escalation protocol.",
        pinned: true,
        patientSourceRef: t.id,
      });
    }
    // Prompt-injection detection. Transcripts, uploaded documents, and
    // patient messages are UNTRUSTED clinical content — never system
    // instructions. This item is `important` (not urgent) but stays pinned.
    if (
      /ignore (all )?previous instructions|system prompt|assistant[:,]/.test(text) ||
      /disregard the (system|rules|policy)/.test(text)
    ) {
      items.push({
        category: "prompt_injection_detected",
        severity: "important",
        message:
          "Patient/transcript text contains instruction-style wording. Treated as patient content, never as system instructions.",
        pinned: true,
        patientSourceRef: t.id,
      });
    }
  }

  // ------------------------------------------------- critical labs
  for (const lab of input.labs) {
    if (lab.value == null) continue;
    if (lab.criticalLow != null && lab.value <= lab.criticalLow) {
      items.push({
        category: "critical_lab",
        severity: "urgent",
        message: `${lab.code} at critical-low value.`,
        pinned: true,
        patientSourceRef: lab.code,
      });
    }
    if (lab.criticalHigh != null && lab.value >= lab.criticalHigh) {
      items.push({
        category: "critical_lab",
        severity: "urgent",
        message: `${lab.code} at critical-high value.`,
        pinned: true,
        patientSourceRef: lab.code,
      });
    }
  }

  // ------------------------------------------------- pregnancy / lactation / peds
  if (input.demographics.isPregnant === true) {
    items.push({
      category: "pregnancy",
      severity: "urgent",
      message:
        "Patient is pregnant. Pregnancy safety review required before any product, dose, or protocol change.",
      pinned: true,
    });
  }
  if (input.demographics.isLactating === true) {
    items.push({
      category: "lactation",
      severity: "important",
      message: "Patient is lactating. Lactation safety review required.",
      pinned: true,
    });
  }
  if (input.demographics.isPediatric === true) {
    items.push({
      category: "pediatrics",
      severity: "urgent",
      message:
        "Pediatric patient. Pediatric safety review required before any recommendation.",
      pinned: true,
    });
  }

  // ------------------------------------------------- allergy conflicts
  const allergen = new Set(input.allergies.map((a) => a.substance.toLowerCase()));
  for (const p of input.currentProtocols) {
    for (const ing of p.ingredients) {
      if (allergen.has(ing.toLowerCase())) {
        items.push({
          category: "medication_allergy",
          severity: "urgent",
          message: `Ingredient "${ing}" conflicts with a recorded allergy.`,
          pinned: true,
          patientSourceRef: p.id,
        });
      }
    }
    // Known contraindications are practitioner-annotated on the protocol.
    for (const c of p.contraindications) {
      items.push({
        category: "known_contraindication",
        severity: "important",
        message: `Contraindication on current protocol: ${c}.`,
        pinned: true,
        patientSourceRef: p.id,
      });
    }
  }

  // ------------------------------------------------- duplicate ingredients across current protocols
  const seen = new Map<string, string>();
  for (const p of input.currentProtocols) {
    for (const ing of p.ingredients) {
      const key = ing.toLowerCase();
      if (seen.has(key) && seen.get(key) !== p.id) {
        items.push({
          category: "duplicate_ingredient",
          severity: "important",
          message: `Duplicate ingredient across current protocols: ${ing}.`,
          pinned: true,
          patientSourceRef: p.id,
        });
      } else {
        seen.set(key, p.id);
      }
    }
  }

  // ------------------------------------------------- missing knowledge
  if (input.interactionReferences.length === 0) {
    items.push({
      category: "missing_interaction_reference",
      severity: "important",
      // EXACT WORDING per the brief.
      message: "Interaction review not completed",
      pinned: true,
    });
  }

  // ------------------------------------------------- missing demographics / reviews
  if (input.demographics.ageYears == null) {
    items.push({
      category: "missing_demographics",
      severity: "important",
      message: "Age missing — cannot apply age-based safety checks.",
      pinned: true,
    });
  }
  if (input.medications.length === 0) {
    items.push({
      category: "missing_medication_review",
      severity: "important",
      message: "Medication review not completed for this run.",
      pinned: true,
    });
  }
  if (input.allergies.length === 0) {
    items.push({
      category: "missing_allergy_review",
      severity: "important",
      message: "Allergy review not completed for this run.",
      pinned: true,
    });
  }

  // ------------------------------------------------- unverified product labels
  for (const l of input.productLabelsInUse) {
    if (l.status !== "verified") {
      items.push({
        category: "unverified_product_label",
        severity: "important",
        message: `Product label ${l.id} is not verified (status=${l.status}). Excluded from any exact-product recommendation.`,
        pinned: true,
        patientSourceRef: l.id,
      });
    }
  }

  // ------------------------------------------------- dosage sources
  for (const d of input.dosageMentions) {
    if (!d.approvedProtocolSourceId && !d.verifiedLabelId) {
      items.push({
        category: "missing_dosage_source",
        severity: "important",
        message: "Dose mention has no approved protocol source and no verified label source.",
        pinned: true,
      });
    }
  }

  // ------------------------------------------------- restricted / jurisdictional
  if (input.restrictedFlagsPresent.length > 0) {
    items.push({
      category: "restricted_or_jurisdictional_content",
      severity: "important",
      message: `Restricted flags present: ${input.restrictedFlagsPresent.join(", ")}. Governed 5-outcome review required.`,
      pinned: true,
    });
  }

  // ------------------------------------------------- staleness
  const now = Date.now();
  const dayMs = 86_400_000;
  const stale = (iso: string | null, days: number) =>
    iso != null && now - Date.parse(iso) > days * dayMs;
  if (stale(input.sourceStaleness.lastImportAt, 90)) {
    items.push({
      category: "stale_evidence",
      severity: "info",
      message: "No imported evidence for over 90 days.",
      pinned: true,
    });
  }
  if (stale(input.sourceStaleness.lastEncounterAt, 180)) {
    items.push({
      category: "stale_patient_input",
      severity: "info",
      message: "No encounter recorded in the last 180 days.",
      pinned: true,
    });
  }

  return items;
}
