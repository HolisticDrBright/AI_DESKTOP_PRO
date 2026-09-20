if (typeof window !== "undefined") throw new Error("clinical-core/recording-acceptance-fixture is server-only.");
import { clinicalUuid, type ClinicalCoreDatabase } from "./database";
import type { SyntheticAcceptanceManifest } from "./synthetic-fixtures";

/** The recording acceptance run needs an open encounter for the fixture patient, and encounters are started by the
 * Desktop's clinical workflow, not by a public route. This provisions one through the same SQL entry point the Desktop
 * uses (`clinical_core.start_encounter`), acting as the fixture practitioner under the synthetic manifest, and reuses an
 * open telehealth encounter it started earlier so repeated runs do not accumulate encounters. It creates nothing else:
 * consent, capture, storage, transcription and drafting releases are reviewed rows outside its reach. */
export async function provisionRecordingAcceptanceEncounter(database: ClinicalCoreDatabase, manifest: SyntheticAcceptanceManifest): Promise<{ encounterId: string; reused: boolean }> {
  if (manifest.environment !== "synthetic-staging" || manifest.dataClassification !== "synthetic_only" || manifest.containsPhi !== false) throw new Error("fixture_boundary_refused");
  const f = manifest.fixture;
  return database.transaction(async (tx) => {
    await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')",
      [clinicalUuid(f.workforcePersonId), clinicalUuid(f.organizationId), f.workforceSubject]);
    const existing = await tx.query<{ id: string }>(`select id::text id from clinical_core.encounters where organization_id=$1 and patient_record_id=$2 and practitioner_person_id=$3
      and visit_type='telehealth' and status='in_progress' and deleted_at is null order by created_at desc limit 1`,
      [clinicalUuid(f.organizationId), clinicalUuid(f.patientRecordId), clinicalUuid(f.workforcePersonId)]);
    if (existing.rows[0]) return { encounterId: existing.rows[0].id, reused: true };
    const started = await tx.query<{ id: string }>("select clinical_core.start_encounter($1,$2,'telehealth',null)::text id", [clinicalUuid(f.organizationId), clinicalUuid(f.patientRecordId)]);
    if (!started.rows[0]?.id) throw new Error("fixture_failed");
    return { encounterId: started.rows[0].id, reused: false };
  });
}
