/**
 * Specs for system-of-record surfaces that are navigable but not yet built.
 *
 * These are internal build specs, not marketing copy: each entry states the
 * surface's job, the intended workflow, the permissions it will require, its
 * honest data source today, and the next action to make it live. The
 * placeholder screen renders these fields verbatim so navigation never implies
 * a capability that does not exist.
 */

export type SurfaceGroup = "Workspace" | "Clinical" | "Operations" | "System";
export type SurfaceStatus = "Spec" | "In design" | "Backend pending";

export interface SurfaceSpec {
  slug: string;
  label: string;
  group: SurfaceGroup;
  /** One line: what this surface is for in the system of record. */
  purpose: string;
  /** The intended workflow, in order. */
  workflow: string[];
  /** Roles / permissions required to use it. */
  permissions: string[];
  /** Honest statement of where data comes from today. */
  dataSource: string;
  status: SurfaceStatus;
  /** The immediate next action to make this surface functional. */
  nextAction: string;
}

export const SURFACES: Record<string, SurfaceSpec> = {
  nutrition: {
    slug: "nutrition",
    label: "Nutrition",
    group: "Clinical",
    purpose:
      "Review patient food logs and translate them into structured nutrition targets tied to the care plan.",
    workflow: [
      "Import or receive patient food logs (photo, barcode, or manual entry)",
      "Practitioner reviews parsed items and corrects portions",
      "Set macro / micronutrient targets against the active protocol",
      "Publish targets to the patient plan after review",
    ],
    permissions: ["Practitioner or Dietitian role", "Patient in your care team"],
    dataSource:
      "No live data yet. The mobile nutrition capture exists; this desktop review surface is not wired to it.",
    status: "Backend pending",
    nextAction:
      "Expose the nutrition-log query through the data adapter, then build the review table.",
  },
  templates: {
    slug: "templates",
    label: "Templates",
    group: "Operations",
    purpose:
      "Reusable protocol, note, and message templates the practice maintains centrally.",
    workflow: [
      "Author a template (protocol, SOAP note, or patient message)",
      "Tag it by condition and care stage",
      "Version and publish to the practice library",
      "Insert into a patient record from the composer",
    ],
    permissions: ["Practitioner role to author", "Admin role to publish practice-wide"],
    dataSource: "No live data yet. Templates will be practice-scoped records.",
    status: "Spec",
    nextAction: "Model the templates table (practice-scoped, versioned) and a list view.",
  },
  automations: {
    slug: "automations",
    label: "Automations",
    group: "Operations",
    purpose:
      "Rule-based triggers that create review tasks — never actions that reach a patient without review.",
    workflow: [
      "Define a trigger (e.g. abnormal lab imported, adherence below threshold)",
      "Choose an internal action (create review task, flag for practitioner)",
      "Practitioner reviews everything the automation queues",
      "Nothing patient-facing is sent automatically",
    ],
    permissions: ["Admin role to create rules", "Practitioner role to act on queued items"],
    dataSource: "No live data yet. Rules will be practice-scoped and audited.",
    status: "In design",
    nextAction:
      "Define the trigger/action schema with a hard constraint: no patient-facing side effects.",
  },
  billing: {
    slug: "billing",
    label: "Billing",
    group: "Operations",
    purpose: "Track invoices, payments, and plan charges for the practice.",
    workflow: [
      "Generate an invoice from a program or visit",
      "Record payment status",
      "Reconcile against the practice ledger",
      "Export for accounting",
    ],
    permissions: ["Admin or Billing role", "Practice-scoped access only"],
    dataSource:
      "No live data yet. Billing will integrate a payment processor; no card data is stored in-app.",
    status: "Backend pending",
    nextAction: "Choose the payment processor and define the invoice record shape.",
  },
  claims: {
    slug: "claims",
    label: "Claims",
    group: "Operations",
    purpose: "Prepare and track insurance claims and their status.",
    workflow: [
      "Assemble a claim from visit and coding data",
      "Validate required fields before submission",
      "Submit through the clearinghouse integration",
      "Track status and handle denials",
    ],
    permissions: ["Billing role", "Practice-scoped access only"],
    dataSource: "No live data yet. Requires a clearinghouse integration.",
    status: "Backend pending",
    nextAction: "Confirm the clearinghouse and the claim data model before building the UI.",
  },
  reports: {
    slug: "reports",
    label: "Reports",
    group: "Operations",
    purpose:
      "Practice-level operational reporting: caseload, outcomes, throughput, adherence.",
    workflow: [
      "Choose a report and date range",
      "Aggregate across the practice's patients (respecting access scope)",
      "Review the generated figures",
      "Export or schedule delivery",
    ],
    permissions: ["Practitioner sees own caseload", "Admin sees practice-wide"],
    dataSource:
      "No live data yet. Patient-level report drafts already exist in the composer; this is the practice roll-up.",
    status: "Spec",
    nextAction: "Define aggregate queries that respect per-practitioner access scope.",
  },
  team: {
    slug: "team",
    label: "Team",
    group: "Operations",
    purpose: "Manage practitioners, roles, and care-team assignments.",
    workflow: [
      "Invite a team member and assign a role",
      "Assign patients to care teams",
      "Review workload distribution",
      "Deactivate access when someone leaves",
    ],
    permissions: ["Admin role only"],
    dataSource:
      "No live data yet. Roles and membership are enforced at the database layer (RLS); this is the management UI.",
    status: "Spec",
    nextAction: "Build the membership list backed by the org-membership tables.",
  },
};

export function getSurface(slug: string): SurfaceSpec | undefined {
  return SURFACES[slug];
}
