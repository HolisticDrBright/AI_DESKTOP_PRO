# Cross-device lab recovery — backend handoff

September 15, 2026. Source-only original phases 1/2 increment.
Coordinated details live in V2 expo/docs/cross-device-lab-recovery.md.

Desktop adds the synthetic inventory/recovery routes, new-job index stamps and
stored original request metadata. Deploy the lab extension template/API bundle
first. LabOwnerInventory must become ACTIVE; hosted tests must exercise account
denial, stale index deletion/expiry, pagination, fingerprint changes and unavailable
index behavior before mobile rollout. Query IAM covers only the index; consistent
base-row reads still check current ownership. No Scan permission or AWS writes ran.

Older jobs without index fields are not silently migrated and retain original-device
recovery; a reviewed migration remains. Empty inventory is not proof of data absence.
The UI explains indexing delay and older-request limitations.

Client-provided source fingerprints are change-detection metadata, not clinical
approval. Replay binds the fingerprint in its immutable input hash. Recovery does
not recompute it from current labs. Old clients may omit it; new clients require
this backend first. No legacy-create fallback is added.

No PHI/provider activation, paid build or commercial completion is claimed.
Full erasure, late-upload cleanup, physical acceptance and production conversion
remain open. Holds, exclusions and source-verification requirements are unchanged.
