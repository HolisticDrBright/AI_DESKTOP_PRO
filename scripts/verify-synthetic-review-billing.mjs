import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("synthetic_review_billing_verification_configuration_missing");
  return value;
}

if (required("CLINICAL_CORE_ENVIRONMENT") !== "synthetic-staging"
  || required("CLINICAL_CORE_DATA_CLASSIFICATION") !== "synthetic_only"
  || required("PHI_ALLOWED") !== "false") {
  throw new Error("synthetic_review_billing_verification_boundary_refused");
}

const common = {
  resourceArn: required("CLINICAL_DATABASE_CLUSTER_ARN"),
  secretArn: required("CLINICAL_DATABASE_SECRET_ARN"),
  database: required("CLINICAL_DATABASE_NAME"),
};
const client = new RDSDataClient({ region: process.env.AWS_REGION });

async function execute(sql, transactionId, parameters = []) {
  return client.send(new ExecuteStatementCommand({
    ...common, transactionId, sql, parameters, includeResultMetadata: true,
  }));
}

function textField(field) {
  if (!field || field.isNull) return null;
  if (typeof field.stringValue === "string") return field.stringValue;
  if (typeof field.longValue === "number") return String(field.longValue);
  throw new Error("synthetic_review_billing_verification_result_invalid");
}

async function transaction(work) {
  const begun = await client.send(new BeginTransactionCommand(common));
  const transactionId = begun.transactionId;
  if (!transactionId) throw new Error("synthetic_review_billing_verification_transaction_failed");
  try {
    const value = await work(transactionId);
    await client.send(new CommitTransactionCommand({ ...common, transactionId }));
    return value;
  } catch (error) {
    await client.send(new RollbackTransactionCommand({ ...common, transactionId })).catch(() => undefined);
    throw error;
  }
}

const identityResult = await execute(`
  select identity.person_id::text, identity.identity_subject,
    membership.organization_id::text,
    coalesce((
      select operation.reviewed_by_person_id::text
      from clinical_core.desktop_compatibility_operations operation
      where operation.enabled = true and operation.reviewed_by_person_id is not null
      order by operation.reviewed_at desc nulls last limit 1
    ), identity.person_id::text)
  from clinical_core.identities identity
  join clinical_core.organization_memberships membership
    on membership.person_id = identity.person_id and membership.status = 'active'
  join clinical_core.organizations organization
    on organization.id = membership.organization_id and organization.contains_phi = false
  where identity.identity_pool = 'workforce' and identity.status = 'active'
    and identity.synthetic_attested = true
    and membership.role in ('owner','admin','practitioner')
  order by (membership.role = 'owner') desc, membership.created_at
  limit 1
`);
const identity = identityResult.records?.[0];
if (!identity) throw new Error("synthetic_review_billing_verification_identity_missing");
const [actorPersonId, identitySubject, organizationId, reviewerPersonId] = identity.map(textField);
if (!actorPersonId || !identitySubject || !organizationId || !reviewerPersonId) {
  throw new Error("synthetic_review_billing_verification_identity_invalid");
}

const contextParameters = [
  { name: "actor", value: { stringValue: actorPersonId }, typeHint: "UUID" },
  { name: "organization", value: { stringValue: organizationId }, typeHint: "UUID" },
  { name: "pool", value: { stringValue: "workforce" } },
  { name: "subject", value: { stringValue: identitySubject } },
  { name: "purpose", value: { stringValue: "clinical_data" } },
  { name: "environment", value: { stringValue: "synthetic-staging" } },
  { name: "classification", value: { stringValue: "synthetic_only" } },
];

async function setContext(transactionId) {
  await execute("set local role clinical_core_api", transactionId);
  await execute(`select clinical_private.set_request_context(
    :actor,:organization,:pool,:subject,:purpose,:environment,:classification
  )`, transactionId, contextParameters);
}

function requestParameter(value) {
  return [{ name: "request", value: { stringValue: JSON.stringify(value) }, typeHint: "JSON" }];
}

async function callWrapper(transactionId, value) {
  const result = await execute(
    "select clinical_compatibility.synthetic_review_billing_v1(:request::jsonb)::text",
    transactionId,
    requestParameter(value),
  );
  const raw = textField(result.records?.[0]?.[0]);
  if (!raw) throw new Error("synthetic_review_billing_verification_empty_result");
  return JSON.parse(raw);
}

function reviewRequest() {
  return {
    kind: "rpc", functionName: "list_review_queue",
    args: { _organization_id: organizationId },
  };
}

function billingRequest() {
  return {
    kind: "rpc", functionName: "get_billing_workspace",
    args: {
      _organization_id: organizationId,
      _from: null,
      _to: null,
      _status: null,
      _practitioner_user_id: null,
      _location_id: null,
      _method: null,
    },
  };
}

const direct = await transaction(async (transactionId) => {
  await setContext(transactionId);
  const queue = await callWrapper(transactionId, reviewRequest());
  const billing = await callWrapper(transactionId, billingRequest());
  if (!Array.isArray(queue) || queue.some((item) => item.item_type !== "lab_extraction")) {
    throw new Error("synthetic_review_queue_projection_invalid");
  }
  const billingKeys = ["summary","invoices","payments","aging","productSales","inventory","reconciliation"];
  if (!billing || billingKeys.some((key) => !(key in billing))
    || !Array.isArray(billing.invoices) || !Array.isArray(billing.payments)) {
    throw new Error("synthetic_billing_workspace_invalid");
  }
  return { queueCount: queue.length, invoiceCount: billing.invoices.length, paymentCount: billing.payments.length };
});

const activation = await execute(`
  update clinical_core.desktop_compatibility_operations operation
  set enabled = true, reviewed_by_person_id = :reviewer::uuid, reviewed_at = clock_timestamp()
  where operation.kind = 'rpc'
    and operation.operation_name in ('list_review_queue','resolve_review_queue_item','get_billing_workspace')
    and operation.handler_schema = 'clinical_compatibility'
    and operation.handler_function = 'synthetic_review_billing_v1'
    and operation.source_sha256 = encode(public.digest(convert_to(
      pg_get_functiondef('clinical_compatibility.synthetic_review_billing_v1(jsonb)'::regprocedure),
      'UTF8'), 'sha256'), 'hex')
  returning operation.operation_name
`, undefined, [{ name: "reviewer", value: { stringValue: reviewerPersonId }, typeHint: "UUID" }]);
if (activation.records?.length !== 3) throw new Error("synthetic_review_billing_activation_refused");

const routed = await transaction(async (transactionId) => {
  await setContext(transactionId);
  const call = async (value) => {
    const result = await execute(
      "select clinical_core.invoke_desktop_compatibility('rpc',:request::jsonb)::text",
      transactionId,
      requestParameter(value),
    );
    return JSON.parse(textField(result.records?.[0]?.[0]));
  };
  const queue = await call(reviewRequest());
  const billing = await call(billingRequest());
  return { queueCount: queue.length, invoiceCount: billing.invoices.length, paymentCount: billing.payments.length };
});

let crossTenantRefused = false;
try {
  await transaction(async (transactionId) => {
    await setContext(transactionId);
    await execute(
      "select clinical_core.invoke_desktop_compatibility('rpc',:request::jsonb)::text",
      transactionId,
      requestParameter({
        kind: "rpc", functionName: "list_review_queue",
        args: { _organization_id: "00000000-0000-4000-8000-000000000000" },
      }),
    );
  });
} catch {
  crossTenantRefused = true;
}
if (!crossTenantRefused) throw new Error("synthetic_review_billing_cross_tenant_guard_failed");

process.stdout.write(JSON.stringify({
  ok: true,
  activatedOperations: activation.records.length,
  direct,
  routed,
  crossTenantRefused,
  phiAllowed: false,
}));
