/**
 * Shared clinical content registry — types.
 *
 * The registry is the single, versioned source of truth for questionnaire
 * content, scoring, lab catalog + recommendation rules, the supplement
 * registry, and protocol templates. Mobile UI, backend procedures, and the
 * desktop platform (byte-identical vendored copy, sha256-enforced) all read
 * THIS content — nothing clinical is hardcoded in screens or prompts.
 *
 * Language rule: scores are "symptom-pattern screening scores" — never a
 * disease risk, probability, or diagnosis.
 */

export type SeverityValue = 0 | 1 | 2 | 3 | 4;
export type SpecialAnswer = 'not_applicable' | 'unsure' | 'prefer_not_to_answer';
export type AnswerValue = SeverityValue | SpecialAnswer;

export interface RegistryQuestion {
  id: string;
  text: string;
}

export interface RegistryCategory {
  id: string;
  name: string;
  icon: string;
  description: string;
  questions: RegistryQuestion[];
}

export interface InterpretationBand {
  id: 'below-threshold' | 'moderate' | 'elevated';
  label: string;
  min: number;
}

export interface QuestionnaireDefinition {
  id: string;
  version: string;
  effectiveDate: string;
  scoringVersion: string;
  legacyScoringVersion: string;
  answerScale: {
    type: string;
    options: { value: SeverityValue; label: string }[];
    specialAnswers: { value: SpecialAnswer; label: string }[];
  };
  interpretation: {
    bands: InterpretationBand[];
    insufficientDataBelowCompleteness: number;
  };
  categories: RegistryCategory[];
}

export interface LabCatalogEntry {
  id: string;
  panelName: string;
  vendor: string | null;
  kind: string;
  specimen: string;
  orderCode: string | null;
  jurisdictions: string[] | null;
  active: boolean;
  vendorVerified: boolean;
  orderLink: { url: string | null; reviewStatus: 'unreviewed' | 'reviewed' | 'not_applicable' };
}

export interface LabRule {
  categoryId: string;
  labId: string;
  priority: 'primary' | 'conditional';
  why: string;
  legacyAliasId: string;
}

export type ApprovalState = 'approved' | 'pending_verification' | 'rejected' | 'superseded';
export type ProductProvenance = 'structured-catalog' | 'ai-prompt' | 'owner-list' | 'desktop-mock';

export interface RegistryProduct {
  id: string;
  name: string;
  brand: string;
  formulation: string;
  doseText: string;
  /** Candidate-matching hints from the legacy extraction prompt (pending verification). */
  indications: string[] | null;
  doseBounds: { minPerDay?: string; maxPerDay?: string } | null;
  ingredients: string[] | null;
  cautions: string[] | null;
  interactions: string[] | null;
  monitoring: string[] | null;
  approvalState: ApprovalState;
  provenance: ProductProvenance;
  sourceRef: string;
}

export interface ProtocolTemplateItem {
  supplementId: string;
  doseText: string;
  schedule: string;
  durationDays: number;
  monitoring: string[];
}

export interface ProtocolTemplate {
  id: string;
  version: number;
  name: string;
  status: 'draft' | 'approved' | 'superseded';
  purpose: string;
  items: ProtocolTemplateItem[];
}

export interface ConsentDefinition {
  id: string;
  version: string;
  title: string;
  required: boolean;
  summary: string;
}

export interface IntakeModule {
  id: string;
  title: string;
  kind: string;
  order: number;
  sections?: { order: number; categoryId: string }[];
}

export interface RegistryContent {
  registryVersion: string;
  generated: string;
  clinicalLanguage: { scoreName: string; disclaimer: string };
  questionnaire: QuestionnaireDefinition;
  labCatalog: LabCatalogEntry[];
  labRules: { version: string; triggerBand: string; notes: string; rules: LabRule[] };
  supplements: {
    version: string;
    authoritativeListStatus: 'not_found' | 'confirmed';
    reconciliationDoc: string;
    products: RegistryProduct[];
  };
  protocolTemplates: ProtocolTemplate[];
  consents: ConsentDefinition[];
  intakeModules: IntakeModule[];
}

/* ------------------------------------------------------------- scoring I/O */

export interface SubmittedAnswer {
  questionId: string;
  value: AnswerValue;
}

export type ScoreBand = 'insufficient_data' | 'below-threshold' | 'moderate' | 'elevated';

export interface CategoryScreeningScore {
  categoryId: string;
  categoryName: string;
  answered: number;
  special: number;
  unanswered: number;
  totalQuestions: number;
  rawSum: number;
  maxForAnswered: number;
  /** Unrounded percent of the ANSWERED maximum; null when insufficient data. */
  percent: number | null;
  /** Display rounding of `percent`; banding always uses the unrounded value. */
  rounded: number | null;
  completeness: number;
  band: ScoreBand;
}

export interface ScreeningResult {
  questionnaireVersion: string;
  scoringVersion: string;
  registryVersion: string;
  categories: CategoryScreeningScore[];
  elevatedCategoryIds: string[];
  moderateOrHigherCategoryIds: string[];
  /** Answer IDs not present in this questionnaire version (rejected, never scored). */
  unknownQuestionIds: string[];
}

export interface LabRecommendation {
  labId: string;
  panelName: string;
  vendor: string | null;
  priority: 'primary' | 'conditional';
  sourceCategoryIds: string[];
  why: string;
  highestBand: 'moderate' | 'elevated';
  orderLinkReviewStatus: 'unreviewed' | 'reviewed' | 'not_applicable';
}

export interface LabRecommendationResult {
  ruleVersion: string;
  registryVersion: string;
  recommendations: LabRecommendation[];
}
