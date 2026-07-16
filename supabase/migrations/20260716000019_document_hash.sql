-- 0019_document_hash
-- True-source provenance (P0): store the SHA-256 of every uploaded lab
-- document so an extracted value can always be traced to the exact bytes it
-- came from (and tampering/duplicates are detectable). Computed by the backend
-- at upload time; historical rows stay NULL (their originals predate hashing).
alter table public.lab_documents
  add column if not exists document_sha256 text
  check (document_sha256 is null or document_sha256 ~ '^[0-9a-f]{64}$');
