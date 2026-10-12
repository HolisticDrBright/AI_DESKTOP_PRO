if (typeof window !== "undefined") {
  throw new Error("commerce/journey-fixture is server-only.");
}
import { funnelDefinition, publishedFunnel, type FunnelDefinition } from "../../funnels";
import { isContractFixtureAllowed } from "../runtime/contractFixture";
import { FICTIONAL_REVIEW_FIXTURE } from "./program-commerce-authority";
import { fictionalCurriculumDigest, selectProgramCheckout, selectProgramOfferLedger } from "./program-commerce-runtime";

/**
 * The fully mounted fictional purchase-to-learning journey: a SEPARATELY configured local fixture.
 *
 * It exists only when BOTH the local contract-fixture boundary admits this process (never in a
 * deployment) AND `COMMERCE_JOURNEY_FIXTURE=1`. Then, and only then, this process has:
 *   - a fictional clinic and a fictional published program with the fixture course;
 *   - a fictional offer published under the fixture's reviewed-looking terms, whose reviewer reads
 *     `FICTIONAL REVIEW FIXTURE` everywhere it appears and whose amount is a fixture amount;
 *   - a fixture funnel at its own slug, `fictional-journey-fixture`, bound to that program. The
 *     repository's real funnel definitions are untouched: they stay drafts with no program bound.
 * Nothing here can be counted as activation evidence: the offer and terms live only in this
 * process's memory, and the production resolver never sees the fixture funnel.
 */
export const JOURNEY_FIXTURE_FLAG = "COMMERCE_JOURNEY_FIXTURE";
export function journeyFixtureAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return isContractFixtureAllowed(env as never) && env[JOURNEY_FIXTURE_FLAG] === "1";
}

const fixtureId = (n: number) => "7e1a0000-0000-4000-8000-" + String(n).padStart(12, "0");
export const JOURNEY_FIXTURE = {
  slug: "fictional-journey-fixture",
  organizationId: fixtureId(1),
  programId: fixtureId(2),
  versionId: fixtureId(3),
  /** The version a "stale curriculum" step publishes after the first purchases. */
  laterVersionId: fixtureId(4),
  staffPersonId: fixtureId(5),
  priceRef: "price_FictionalJourney01",
  /** A fixture amount: not a price anyone chose, and deliberately unlike any real one. */
  amountMinor: 1234,
  accessTermsVersion: "education-access-terms/1",
  accessDurationDays: 30,
  learners: {
    a: { personId: fixtureId(10), identitySubject: "sub:fictional-learner-a" },
    b: { personId: fixtureId(11), identitySubject: "sub:fictional-learner-b" },
  },
} as const;
export const JOURNEY_PURCHASER_ADDRESS = "fictional-purchaser@journey-fixture.example";

export const JOURNEY_COURSE_TITLE = "Fictional journey course (test fixture)";
export const journeyCoursePhases = (variant: "first" | "later" = "first") => [
  {
    id: "phase-1", title: "Fictional phase one", days: 7, transition: "scheduled", items: [
      { id: "lesson-a", title: "Fictional lesson A", kind: "lesson", instructions: variant === "first" ? "Fictional reading A for the journey fixture. Nothing here is advice." : "Fictional reading A, revised.", released: true },
      { id: "habit-b", title: "Fictional habit B", kind: "habit", instructions: "Fictional practice B for the journey fixture.", released: true },
    ],
  },
  {
    id: "phase-2", title: "Fictional phase two", days: 7, transition: "scheduled", items: [
      { id: "lesson-c", title: "Fictional lesson C", kind: "lesson", instructions: "Fictional reading C for the journey fixture.", released: true },
    ],
  },
];

/** The fixture funnel. Published only inside the fixture; its approval names the fixture, never a person. */
export const journeyFixtureFunnel: FunnelDefinition = funnelDefinition.parse({
  slug: JOURNEY_FIXTURE.slug,
  status: "published",
  title: "Fictional journey program (test fixture)",
  description: "A fictional program used only by the local test fixture. Nothing on this page is a real program, price or offer.",
  indexable: false,
  programLabel: "Fictional journey program (test fixture)",
  consultSlug: "longevity-program",
  programBinding: { organizationId: JOURNEY_FIXTURE.organizationId, programId: JOURNEY_FIXTURE.programId },
  sections: [
    { kind: "hero", heading: "A fictional program for the local test fixture", lead: "This page exists only in a local test run. You can request a consultation, or buy the fictional program to exercise the purchase journey end to end." },
    { kind: "what-is-included", heading: "What the fictional program includes", source: "published_program", items: ["Fictional lesson A", "Fictional habit B", "Fictional lesson C"] },
    { kind: "call-to-action", heading: "Two ways to start", detail: "Request a consultation, or buy the fictional program. The fixture shows its terms before anything is charged.", buttonLabel: "Request a consultation" },
  ],
  approval: { by: FICTIONAL_REVIEW_FIXTURE, on: "2026-10-12", attorneyReview: false },
  draftNote: null,
});

/**
 * The public resolver the funnel, purchase and checkout routes use: a published repository funnel,
 * or, inside the journey fixture only, the fixture funnel. Outside the fixture the fixture slug is
 * the same absence as any unknown slug.
 */
export async function resolvePublicFunnel(slug: string, env: Record<string, string | undefined> = process.env): Promise<FunnelDefinition | null> {
  const published = publishedFunnel(slug);
  if (published) return published;
  if (slug !== JOURNEY_FIXTURE.slug || !journeyFixtureAllowed(env)) return null;
  await ensureJourneySeed(env);
  return journeyFixtureFunnel;
}
/** The same, for a funnel already known to exist (the return page): no seeding. */
export function knownFunnel(slug: string, env: Record<string, string | undefined> = process.env): FunnelDefinition | null {
  return publishedFunnel(slug) ?? (slug === JOURNEY_FIXTURE.slug && journeyFixtureAllowed(env) ? journeyFixtureFunnel : null);
}

const staffActor = { personId: JOURNEY_FIXTURE.staffPersonId, organizationId: JOURNEY_FIXTURE.organizationId };
/** Held once per process, like the runtime it seeds (pages and route handlers are separate module graphs). */
const SEED_KEY = Symbol.for("alp.commerce.journey-seed");
const seed = ((globalThis as unknown as Record<symbol, { pending: Promise<void> | null } | undefined>)[SEED_KEY] ??= { pending: null });

/** Publish the fixture course, offer and price into this process's fictional ledgers, once. */
export function ensureJourneySeed(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (!journeyFixtureAllowed(env)) return Promise.reject(new Error("journey fixture not configured"));
  seed.pending ??= (async () => {
    const offers = selectProgramOfferLedger(env);
    const checkout = selectProgramCheckout(env);
    if (offers.kind !== "fictional" || checkout.kind !== "fictional") throw new Error("journey fixture needs the fictional ledgers");
    publishCourse("first", env);
    checkout.processor.setPriceAmount(JOURNEY_FIXTURE.priceRef, JOURNEY_FIXTURE.amountMinor);
    const listed = await offers.ledger.execute(staffActor, { action: "list", programId: JOURNEY_FIXTURE.programId });
    if (listed.action === "list" && listed.offers.some(offer => offer.state === "published")) return;
    const created = await offers.ledger.execute(staffActor, { action: "create", programId: JOURNEY_FIXTURE.programId, terms: {
      mode: "paid", name: "Fictional journey program (test fixture)", pricing: { currency: "USD", amountMinor: JOURNEY_FIXTURE.amountMinor, billing: { kind: "one_time" } },
      providerPriceRef: JOURNEY_FIXTURE.priceRef, accessTermsVersion: JOURNEY_FIXTURE.accessTermsVersion, accessDurationDays: JOURNEY_FIXTURE.accessDurationDays,
    } });
    if (created.action !== "create") throw new Error("journey fixture offer not created");
    await offers.ledger.execute(staffActor, { action: "approve_provider_mapping", offerId: created.offer.offerId, expectedRevision: 1 });
    await offers.ledger.execute(staffActor, { action: "publish", offerId: created.offer.offerId, expectedRevision: 2 });
  })().catch(error => { seed.pending = null; throw error; });
  return seed.pending;
}

/** Register a course version as the program's current published one; the earlier version's content stays readable for what was already sold. */
export function publishCourse(variant: "first" | "later", env: Record<string, string | undefined> = process.env): void {
  const offers = selectProgramOfferLedger(env);
  if (offers.kind !== "fictional") throw new Error("journey fixture needs the fictional ledgers");
  const phases = journeyCoursePhases(variant);
  const consumerProgram = { title: JOURNEY_COURSE_TITLE, phases };
  offers.registerCurriculum(JOURNEY_FIXTURE.organizationId, JOURNEY_FIXTURE.programId, {
    versionId: variant === "first" ? JOURNEY_FIXTURE.versionId : JOURNEY_FIXTURE.laterVersionId, version: variant === "first" ? 1 : 2,
    sourceDigest: fictionalCurriculumDigest(consumerProgram)!,
  }, consumerProgram);
}

/** Test-only: forget the seed so the next use publishes again (after the runtime reset). */
export function __resetJourneySeed(): void { seed.pending = null; }
