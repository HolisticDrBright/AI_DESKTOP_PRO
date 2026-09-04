export type LabRangeDirection = "below" | "within" | "above" | "unknown";

export type DirectionalLabBiomarker = {
  biomarkerId: string;
  canonicalName: string;
  value: number;
  unit: string;
  labMin: number | null;
  labMax: number | null;
  functionalMin: number | null;
  functionalMax: number | null;
  status: string;
  panelId?: string;
  testDate?: string;
};

export type LabRangeAssessment = {
  reportingDirection: LabRangeDirection;
  functionalDirection: LabRangeDirection;
  primaryDirection: LabRangeDirection;
  primaryBasis: "functional" | "reporting_laboratory" | "none";
  sourceStatusAlignment: "aligned" | "conflicts" | "indeterminate";
};

export type LabRelationshipGroup = {
  groupId: string;
  label: string;
  biomarkerIds: string[];
  outsideRangeBiomarkerIds: string[];
  instruction: "review_together_not_a_diagnosis";
};

type RelationshipRule = {
  groupId: string;
  label: string;
  marker: RegExp;
};

const RELATIONSHIP_RULES: readonly RelationshipRule[] = [
  { groupId: "iron_studies", label: "Iron transport and storage", marker: /^(?:serum )?iron$|ferritin|transferrin|\btibc\b|\buibc\b|iron saturation|total iron binding/i },
  { groupId: "blood_count", label: "Red-cell and oxygen-carrying indices", marker: /hemoglobin|hematocrit|red blood cell|\brbc\b|\bmcv\b|\bmch\b|\bmchc\b|\brdw\b/i },
  { groupId: "glucose_regulation", label: "Glucose regulation", marker: /^(?:fasting )?glucose$|hemoglobin a1c|\bhba1c\b|\ba1c\b|fasting insulin|c peptide|c-peptide/i },
  { groupId: "lipids", label: "Lipid transport and triglycerides", marker: /total cholesterol|\bhdl\b|\bldl\b|triglyceride|apolipoprotein|\bapo ?b\b|lipoprotein\s*\(?a\)?|\blp\(?a\)?\b/i },
  { groupId: "thyroid", label: "Thyroid signaling", marker: /thyroid stimulating hormone|\btsh\b|free t4|free thyroxine|free t3|free triiodothyronine|thyroid peroxidase|thyroglobulin antibod|\btpo\b/i },
  { groupId: "liver", label: "Liver-associated markers", marker: /alanine aminotransferase|aspartate aminotransferase|alkaline phosphatase|gamma glutamyl|\balt\b|\bast\b|\bggt\b|bilirubin|albumin/i },
  { groupId: "kidney", label: "Kidney filtration and nitrogen balance", marker: /creatinine|estimated glomerular|\begfr\b|blood urea nitrogen|\bbun\b|cystatin c/i },
  { groupId: "inflammation", label: "Inflammation-associated markers", marker: /c reactive protein|high sensitivity crp|\bhs ?crp\b|erythrocyte sedimentation|\besr\b|ferritin/i },
  { groupId: "electrolytes", label: "Electrolyte and mineral balance", marker: /^sodium$|^potassium$|^chloride$|^calcium$|^magnesium$|carbon dioxide|bicarbonate|\bco2\b/i },
  { groupId: "sex_hormones", label: "Sex-hormone context", marker: /estradiol|estrogen|progesterone|testosterone|dihydrotestosterone|\bdht\b|dehydroepiandrosterone|\bdhea\b|sex hormone binding|\bshbg\b|luteinizing hormone|follicle stimulating hormone|prolactin/i },
] as const;

function validBound(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function assessRangeDirection(value: number, min: number | null, max: number | null): LabRangeDirection {
  if (!Number.isFinite(value)) return "unknown";
  const hasMin = validBound(min);
  const hasMax = validBound(max);
  if (hasMin && hasMax && min > max) return "unknown";
  if (hasMin && value < min) return "below";
  if (hasMax && value > max) return "above";
  // A one-sided bound can prove an out-of-range result, but cannot prove that
  // an unbounded value is within a complete interval.
  if (!hasMin || !hasMax) return "unknown";
  return "within";
}

export function assessLabBiomarker(row: DirectionalLabBiomarker): LabRangeAssessment {
  const reportingDirection = assessRangeDirection(row.value, row.labMin, row.labMax);
  const functionalDirection = assessRangeDirection(row.value, row.functionalMin, row.functionalMax);
  const primaryDirection = functionalDirection !== "unknown" ? functionalDirection : reportingDirection;
  const primaryBasis = functionalDirection !== "unknown"
    ? "functional"
    : reportingDirection !== "unknown" ? "reporting_laboratory" : "none";
  const sourceCallsOutside = row.status === "suboptimal" || row.status === "critical";
  const computedCallsOutside = primaryDirection === "below" || primaryDirection === "above";
  const sourceStatusAlignment = primaryDirection === "unknown"
    ? "indeterminate"
    : sourceCallsOutside === computedCallsOutside ? "aligned" : "conflicts";
  return { reportingDirection, functionalDirection, primaryDirection, primaryBasis, sourceStatusAlignment };
}

export function buildDirectionalLabContext(biomarkers: DirectionalLabBiomarker[]): {
  biomarkers: Array<DirectionalLabBiomarker & { rangeAssessment: LabRangeAssessment }>;
  relationshipGroups: LabRelationshipGroup[];
} {
  const assessed = biomarkers.map((row) => ({ ...row, rangeAssessment: assessLabBiomarker(row) }));
  const relationshipGroups = RELATIONSHIP_RULES.flatMap((rule): LabRelationshipGroup[] => {
    const members = assessed.filter((row) => rule.marker.test(row.canonicalName));
    const unique = members.filter((row, index, all) => all.findIndex((candidate) => candidate.biomarkerId === row.biomarkerId) === index);
    const outside = unique.filter((row) => row.rangeAssessment.primaryDirection === "below" || row.rangeAssessment.primaryDirection === "above");
    if (unique.length < 2 || outside.length < 1) return [];
    return [{
      groupId: rule.groupId,
      label: rule.label,
      biomarkerIds: unique.map((row) => row.biomarkerId).slice(0, 40),
      outsideRangeBiomarkerIds: outside.map((row) => row.biomarkerId).slice(0, 40),
      instruction: "review_together_not_a_diagnosis",
    }];
  });
  return { biomarkers: assessed, relationshipGroups: relationshipGroups.slice(0, 12) };
}
