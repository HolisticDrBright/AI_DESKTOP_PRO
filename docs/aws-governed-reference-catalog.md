# AWS governed reference catalog

## Current status

The governed catalog is implemented and deployed to the isolated synthetic AWS
account. Both catalog migrations are applied, the hash-pinned package was
imported as `needs_review`, and the three JWT-protected routes are live. The
import activated no clinical or commercial records. The production account
remains `PHI_ALLOWED=false` and has no catalog workload.

This work deliberately does not copy catalog data into either shared Supabase
project. Supabase remains synthetic staging and is not a fallback if the AWS
catalog is unavailable.

## Authority and separation

- `clinical_reference` owns versioned product knowledge, label evidence and
  cross-checks, safety rules, knowledge sources, protocol templates, 163
  first-class protocol steps, dose provenance, import ledgers, and append-only
  review evidence.
- `commercial_reference` owns versioned affiliate destinations and tracking
  metadata. Clinical SQL does not read this schema.
- Catalog packages declare `containsPhi=false` and
  `dataClassification=reference_only`. The importer verifies both values and
  the target environment before opening a transaction.
- Product, product-label, offer, template, protocol-step, safety-rule, and
  knowledge-source versions are immutable. Import always lands as
  `needs_review`; named approval changes only the registry's active version.
- Restricted or injectable products cannot allow direct ordering. Protocol
  items with a recorded dose must name its source.

## Independent migration ledger

Catalog migrations live under
`infra/aws-clinical-core/catalog-migrations`. They use
`clinical_reference.schema_migrations` and a catalog-specific advisory lock.
They do not share the synthetic identity ledger, so a production catalog
migration cannot accidentally install the synthetic identity schema.

## Seed contract

Claude's authoring-data track supplies source package schema `1.0.0`. The
`adapt` command verifies the raw manifest file SHA-256 and every listed file
hash/count, then deterministically emits `governed-catalog-seed/1`. The AWS
package includes:

- a canonical manifest SHA-256;
- per-product, per-label, per-offer, per-template, per-step,
  per-safety-rule, and per-knowledge-source content SHA-256 values;
- deterministic stable IDs and positive versions;
- source references and explicit restrictions;
- separately modeled clinical and commercial content;
- first-class protocol steps, including non-product assessment, safety, and
  monitoring steps, plus dose sources for every non-empty protocol dose; and
- an exact target environment (`synthetic-staging` or
  `production-clinical`).

Duplicate manifest application returns the prior batch. Reusing a stable ID
and version with different content is refused.

The frozen source commit is `8e866aa`. Its manifest file SHA-256 is
`feeda0c11d46eca0096fc1b8c74fcdd5cf495cbaba462c8cc6659de39e8cf220`;
the deterministically adapted AWS manifest SHA-256 is
`9dee1f5f8c960a7889a28da983bfbe3df71f649dd08a7fbd927329fae2db4b1e`.
It reconciles to 133 products, 91 labels, 91 label cross-checks, 91 commercial
offers, 32 protocol templates, 163 protocol steps, 55 safety rules, and 76
canonical knowledge sources. The source file contains 77 source rows because
`SRC_FDA_COMPOUNDING_RISK` is duplicated with identical content; the adapter
preserves both provenance rows on one immutable source.

All imported records remain review-locked. Six substantive label conflicts,
physical-label requirements, missing labels, invalid/redacted evidence URLs,
and practitioner-decision flags fail closed until named reviewers resolve them.

## Read API

`governed-catalog-api/1` exposes three Cognito-JWT routes:

- `GET /clinical-core/consumer/catalog/products`
- `GET /clinical-core/workforce/catalog/products`
- `GET /clinical-core/workforce/catalog/protocol-templates`

Only registry-approved active versions are readable. Clinical products and
commercial offers are returned under separate top-level keys. Consumer access
to protocol templates is not defined.

The Lambda uses Aurora Data API transactions, an AWS-managed database secret,
KMS-encrypted 30-day logs, no VPC/NAT route, and no request-body logging.

## Operator sequence

The bundled `catalogOperator` supports four explicit commands:

1. `adapt` — verify Claude's raw source package and write a new AWS manifest
   without overwriting an existing output.
2. `migrate` — apply only the independent catalog migration ledger.
3. `import` — validate and import a hash-pinned seed package as
   `needs_review`.
4. `review` — record a named review and activate only a version whose safety
   preconditions pass.

The operator prints identifiers, hashes, counts, outcomes, and timestamps; it
does not print manifest payloads, clinical content, credentials, or review
reasons.

## Remaining activation gates

1. Commit and review the source implementation and the handoff reconciliation.
2. Complete named clinical, safety, citation, commercial, and label review; verify restricted-product
   and dose-provenance refusals.
3. Run authenticated synthetic browser/API acceptance with a reviewed test
   product after review evidence exists.
4. Reconcile counts and hashes in the production-reference account while PHI
   remains disabled.

None of these steps authorizes real patient data. PHI activation remains a
separate legal, security, clinical-safety, recovery, and engineering gate.
