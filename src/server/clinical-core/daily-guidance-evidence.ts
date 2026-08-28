if (typeof window !== "undefined") throw new Error("daily-guidance-evidence is server-only");

export const DAILY_GUIDANCE_EVIDENCE_VERSION = "daily-guidance-evidence/1";

export const DAILY_GUIDANCE_EVIDENCE = {
  "mc-nulty-2020": {
    title: "Menstrual-cycle phase and exercise performance systematic review",
    url: "https://pubmed.ncbi.nlm.nih.gov/32661839/",
    policy: "Do not prescribe training intensity from estimated cycle phase alone; prioritize measured recovery and individual symptoms.",
  },
  "acog-pregnancy-exercise-804": {
    title: "ACOG Physical Activity and Exercise During Pregnancy and the Postpartum Period",
    url: "https://www.acog.org/clinical/clinical-guidance/committee-opinion/articles/2020/04/physical-activity-and-exercise-during-pregnancy-and-the-postpartum-period",
    policy: "Pregnancy and postpartum guidance must be conservative, symptom-aware, and include ACOG stop-and-seek-care warning signs.",
  },
  "acog-abnormal-bleeding": {
    title: "ACOG Abnormal Uterine Bleeding",
    url: "https://www.acog.org/womens-health/faqs/abnormal-uterine-bleeding",
    policy: "Heavy, prolonged, postmenopausal, or symptomatic bleeding requires clinical escalation rather than phase-based wellness advice.",
  },
  "ioc-reds-2023": {
    title: "2023 IOC consensus statement on Relative Energy Deficiency in Sport",
    url: "https://doi.org/10.1136/bjsports-2023-106994",
    policy: "Avoid advice that promotes low energy availability; menstrual dysfunction plus training strain or under-fueling requires escalation.",
  },
  "cdc-adult-activity": {
    title: "CDC Adult Physical Activity Guidelines",
    url: "https://www.cdc.gov/physical-activity-basics/guidelines/adults.html",
    policy: "Use general adult activity guidance as a long-horizon goal, never as a same-day mandate that overrides symptoms or recovery.",
  },
  "menopause-nonhormone-2023": {
    title: "The Menopause Society 2023 nonhormone therapy position statement",
    url: "https://www.menopause.org/docs/default-source/professional/2023-nonhormone-therapy-position-statement.pdf",
    policy: "Do not claim exercise or a specific diet treats vasomotor symptoms; describe general health benefits and symptom-led adjustments only.",
  },
} as const;

export type DailyGuidanceEvidenceId = keyof typeof DAILY_GUIDANCE_EVIDENCE;
export const DAILY_GUIDANCE_EVIDENCE_IDS = Object.keys(DAILY_GUIDANCE_EVIDENCE) as DailyGuidanceEvidenceId[];

export const DAILY_GUIDANCE_REPRODUCTIVE_RULES = {
  regular_cycle: {
    evidenceIds: ["mc-nulty-2020", "ioc-reds-2023"],
    exercise: "No phase alone authorizes a harder or easier workout. Use measured recovery and symptoms; phase can only explain uncertainty or support an optional adjustment.",
    nutrition: "Maintain adequate energy availability and balanced meals. Do not prescribe fasting, restriction, or a phase-specific supplement.",
    phases: {
      menstrual: "If cramps, fatigue, heavy bleeding, dizziness, or pain are reported, favor symptom-led adjustment or escalation; otherwise no automatic restriction.",
      follicular: "Do not automatically increase intensity; measured recovery and the person's experience remain primary.",
      ovulatory: "Do not automatically increase intensity or claim a performance peak.",
      luteal: "If sleep disruption, cravings, bloating, or fatigue are reported, use practical hydration, regular-meal, and recovery suggestions without calorie restriction.",
      unknown: "Do not issue phase-specific guidance.",
    },
  },
  irregular_cycle: {
    evidenceIds: ["ioc-reds-2023", "acog-abnormal-bleeding"],
    exercise: "Do not infer phase. Use measured recovery and symptoms; persistent cycle disruption with training strain or under-fueling warrants routine evaluation.",
    nutrition: "Protect energy availability and avoid restrictive advice.",
  },
  hormonal_contraception: {
    evidenceIds: ["mc-nulty-2020", "cdc-adult-activity"],
    exercise: "Do not infer endogenous cycle phase from calendar day. Use measured recovery and symptoms.",
    nutrition: "Use general balanced-meal guidance only when supported by supplied inputs; do not prescribe a phase diet.",
  },
  pregnant: {
    evidenceIds: ["acog-pregnancy-exercise-804"],
    exercise: "Keep suggestions moderate and symptom-led, never override obstetric restrictions, and escalate ACOG warning symptoms.",
    nutrition: "Do not prescribe restriction, fasting, supplements, or weight-loss targets.",
  },
  postpartum: {
    evidenceIds: ["acog-pregnancy-exercise-804"],
    exercise: "Recommend gradual symptom-led return only; delivery complications, pain, bleeding, pelvic-floor symptoms, or warning symptoms require individualized care.",
    nutrition: "Protect recovery and energy availability; do not prescribe restriction or supplements.",
  },
  perimenopause: {
    evidenceIds: ["menopause-nonhormone-2023", "cdc-adult-activity", "acog-abnormal-bleeding"],
    exercise: "Describe general health benefits and symptom-led adjustments; do not claim exercise treats vasomotor symptoms.",
    nutrition: "Use general balanced nutrition only; do not claim a diet treats hot flashes or prescribe hormone-altering products.",
  },
  menopause: {
    evidenceIds: ["menopause-nonhormone-2023", "cdc-adult-activity", "acog-abnormal-bleeding"],
    exercise: "Describe general health benefits and symptom-led adjustments; postmenopausal bleeding requires escalation.",
    nutrition: "Use general balanced nutrition only; do not claim a diet treats vasomotor symptoms.",
  },
  not_applicable: {
    evidenceIds: ["cdc-adult-activity", "ioc-reds-2023"],
    exercise: "Use measured recovery and symptoms without reproductive-phase claims.",
    nutrition: "Protect energy availability and use only supplied inputs.",
  },
  prefer_not_to_say: {
    evidenceIds: ["cdc-adult-activity", "ioc-reds-2023"],
    exercise: "Use measured recovery and symptoms without reproductive-phase claims.",
    nutrition: "Protect energy availability and use only supplied inputs.",
  },
} as const;
