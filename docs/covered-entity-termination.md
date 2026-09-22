# Destroying one covered entity's information

When an agreement with a clinic ends, everything held on its behalf must be returned or destroyed. Being able to say so
is not the same as being able to do it: the hard part is knowing what that clinic's information *is*, across a schema
that keeps growing. So the answer is written down per table and checked at build time.

## The coverage manifest

`infra/aws-clinical-core/covered-entity-coverage.json` lists every table the production artifact creates. Each one is:

- **`organization_column`** — it carries the organization, and its rows for that organization are deleted;
- **`parent`** — it hangs off a table that does, named with the column that reaches it, and is deleted through it;
- **`retained`** — it is kept, with a class and a stated reason.

`npm run check:aws-covered-entity-coverage` rebuilds the production artifact and refuses any table the manifest does not
account for, any retained table that points at deleted rows, and any recorded delete-order dependency that disagrees
with the artifact's own foreign keys. That check is what stops the next table from being quietly forgotten; it runs in
CI beside the other clinical-core gates.

Today it accounts for 202 tables: 104 carrying the organization, 43 reached through a parent, 55 retained.

## What is kept, and why

| Class | Kept because |
| --- | --- |
| `global_reference` | Reviewed reference data shared by every organization, holding no individual's information. |
| `curated_knowledge` | Knowledge and catalog curation attributed to the organization that reviewed it and shared with the others. |
| `individual_account` | Rooted at a person's own account. A person may hold memberships in more than one organization, and their owned records are consumer-self-entered (`docs/record-source-regime.md`), so they are removed by the individual deletion path, not by a clinic's termination. |
| `service_operations` | An operator authorization, retention policy or schema state; never a covered entity's information. |
| `organization_shell` | The organization row itself, so the destruction record stays readable and reviewed reference data remains attributable to the review that produced it. |

Everything else — encounters, notes and their versions, signatures and addenda, recordings, transcripts, proposed
notes, appointments, messages, billing, programs, protocols, memberships, patient records — is deleted.

## Running it

```bash
npm run build:aws-covered-entity-deletion-operator

AWS_REGION=us-east-2 \
EXPECTED_AWS_ACCOUNT_ID=<account> \
CLINICAL_DATABASE_CLUSTER_ARN=<cluster arn> \
CLINICAL_DATABASE_SECRET_ARN=<secret arn> \
CLINICAL_DATABASE_NAME=<database> \
PHI_ALLOWED=<true|false> \
ORGANIZATION_ID=<organization uuid> \
node dist/aws-clinical-core/covered-entity-deletion-operator/index.cjs inspect
```

`inspect` is read-only. It reports the tables that still hold rows for that organization and how many, how many stored
objects hang off them, and whether a legal hold is open on anyone the clinic holds information about.

```bash
CONFIRM_COVERED_ENTITY_TERMINATION=true \
COVERED_ENTITY_TERMINATION_REFERENCE=clinic-termination/2026-09-22 \
… node dist/aws-clinical-core/covered-entity-deletion-operator/index.cjs destroy
```

`destroy` runs in one transaction: it refuses while a legal hold is open, reads the object inventory before deleting
anything, deletes every in-scope table with children before parents, then counts every in-scope table again and fails
the run if anything survived. The report names each table and how many rows it lost, the retained classes, the object
counts, an evidence hash, and `certifies`, which says which stores the run can actually stand behind.

## What it refuses

| Category | Meaning |
| --- | --- |
| `coverage_malformed` | The manifest cannot be read, a chain does not end at the organization, or two tables point at each other. |
| `organization_invalid` | The organization is not a uuid. |
| `termination_unconfirmed` | The operator did not confirm the termination or did not name the ended agreement. |
| `legal_hold_present` | A hold is open on a member of the organization or on someone with a relationship to one of its patient records. |
| `objects_not_purged` | Stored objects are still registered (see below), or a supplied purger did not finish. |
| `object_inventory_too_large` | More object keys than the run will stand behind in one pass. |
| `content_remains` | A table still held rows for the organization after the deletes. The transaction rolls back. |

## Stored objects

Recordings, transcripts and their artifacts live in S3 under versioning and object lock, where a retention period or a
legal hold can legitimately refuse a delete. That is the hold-aware recording cleanup path's job
(`docs/aws-encounter-recording-authority.md`), not this tool's. `destroy` therefore refuses while any object is still
registered: run the cleanup path first, confirm it, then destroy the database content. The module accepts a purger for
callers that have one, and a report with objects and no purger says `objectStores: false` rather than claiming the
destruction was complete.

## What is not automated

- Returning information to the clinic instead of destroying it. The export path is per individual; a clinic-wide return
  has not been built.
- Backups. Point-in-time recovery windows still hold the deleted rows until they age out, which is the retention the
  agreement should state.
- The organization's own identity users in the provider directory, which the identity deletion path removes per person.
