/**
 * CONTRACT-FIXTURE BACKEND — NOT the real clinical backend.
 *
 * A tiny in-memory server that speaks the exact wire contract the desktop's
 * live path expects (Supabase-auth token endpoint + superjson-shaped tRPC
 * procedures). It exists so the live-mode UI can be exercised end-to-end —
 * loading a real queue, resolving an item, persisting across browser reloads,
 * reading the audit trail — in environments where the deployed tRPC backend
 * and the clinical Supabase project are unreachable (sandboxes, offline dev).
 *
 * The real data layer is verified separately against the actual project
 * (supabase/tests/*.sql, run via MCP). This stub holds SYNTHETIC fixture data
 * only — no PHI — and everything lives in process memory: restart = reset.
 *
 * Run:   node scripts/live-stub-server.mjs        (port 3999, STUB_PORT to change)
 * Then:  NEXT_PUBLIC_USE_LIVE_API=true npm run build
 *        TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *        CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 \
 *        CLINICAL_SUPABASE_ANON_KEY=stub CLINICAL_DEMO_EMAIL=demo@local \
 *        CLINICAL_DEMO_PASSWORD=demo CLINICAL_ORG_ID=org-fixture \
 *        npx next start -p 3114
 */
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 3999);

/* ------------------------------------------------------------ fixture state */

const PATIENTS = [
  { id: "aaaaaaaa-1111-2222-3333-444444444401", mrn: "FX-0001", first_name: "Fixture", last_name: "Patient", date_of_birth: "1990-04-12", sex: "female", status: "active" },
  { id: "aaaaaaaa-1111-2222-3333-444444444402", mrn: "FX-0002", first_name: "Sample", last_name: "Client", date_of_birth: "1984-09-03", sex: "male", status: "active" },
];

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

const queue = new Map(
  [
    { id: "bbbbbbbb-1111-2222-3333-444444444401", itemType: "abnormal_result", title: "Recheck hs-CRP after abnormal result", priority: "high", status: "open", patientId: PATIENTS[0].id, patientName: "Fixture Patient", assigneeName: "Demo Practitioner", dueAt: iso(-2 * 864e5), createdAt: iso(3 * 864e5) },
    { id: "bbbbbbbb-1111-2222-3333-444444444402", itemType: "lab_extraction", title: "Verify extracted markers from uploaded panel", priority: "medium", status: "open", patientId: PATIENTS[0].id, patientName: "Fixture Patient", assigneeName: "Demo Practitioner", dueAt: iso(0), createdAt: iso(2 * 864e5) },
    { id: "bbbbbbbb-1111-2222-3333-444444444403", itemType: "hypothesis", title: "Review updated reasoning hypothesis", priority: "medium", status: "open", patientId: PATIENTS[1].id, patientName: "Sample Client", assigneeName: null, dueAt: null, createdAt: iso(864e5) },
    { id: "bbbbbbbb-1111-2222-3333-444444444404", itemType: "assessment", title: "Quarterly org QA checklist", priority: "low", status: "resolved", patientId: null, patientName: null, assigneeName: "Demo Practitioner", dueAt: null, createdAt: iso(5 * 864e5) },
  ].map((r) => [r.id, r]),
);

const auditEvents = [];
let auditSeq = 0;
function pushAudit(action, resourceType, resourceId, safeMessage, metadata, patientId = null) {
  auditEvents.unshift({
    id: `cccccccc-1111-2222-3333-${String(444444444400 + ++auditSeq)}`,
    action,
    resourceType,
    resourceId,
    safeMessage,
    metadata,
    patientId,
    actorUserId: "dddddddd-1111-2222-3333-444444444401",
    occurredAt: new Date().toISOString(),
  });
}

/* --------------------------------------------------------------- wire utils */

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const trpcOk = (res, value) => json(res, 200, { result: { data: { json: value } } });
const trpcErr = (res, status, code, message) =>
  json(res, status, { error: { json: { message, data: { code, httpStatus: status } } } });

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });

/* ------------------------------------------------------------------- server */

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // Supabase-auth-shaped token endpoint (identity only, fixture token).
  if (url.pathname === "/auth/v1/token") {
    return json(res, 200, { access_token: "fixture-access-token", expires_in: 3600 });
  }

  if (!url.pathname.startsWith("/api/trpc/")) return json(res, 404, { error: "not found" });

  // Every procedure requires a bearer — exercises the desktop's auth path.
  if (!/^Bearer .+/.test(req.headers.authorization ?? "")) {
    return trpcErr(res, 401, "UNAUTHORIZED", "missing bearer");
  }

  const proc = url.pathname.slice("/api/trpc/".length);
  const input =
    req.method === "GET"
      ? JSON.parse(url.searchParams.get("input") ?? "{}").json ?? {}
      : (await readBody(req)).json ?? {};

  switch (proc) {
    case "clinical.patients.list":
      return trpcOk(res, PATIENTS);
    case "clinical.patients.get": {
      const row = PATIENTS.find((p) => p.id === input.patientId);
      return row ? trpcOk(res, row) : trpcErr(res, 404, "NOT_FOUND", "no such patient");
    }
    case "clinical.tasks.getQueue":
      return trpcOk(res, [...queue.values()]);
    case "clinical.tasks.resolve": {
      const item = queue.get(input.itemId);
      if (!item) return trpcErr(res, 404, "NOT_FOUND", "no such item");
      if (item.status === "resolved") {
        return trpcOk(res, { id: item.id, status: "resolved", previousStatus: "resolved", alreadyResolved: true });
      }
      const previous = item.status;
      item.status = "resolved";
      pushAudit(
        "review_task.resolve",
        "review_queue_item",
        item.id,
        "Review task resolved",
        { previous_status: previous, item_type: item.itemType, note_present: Boolean(input.note) },
        item.patientId,
      );
      return trpcOk(res, {
        id: item.id,
        status: "resolved",
        previousStatus: previous,
        alreadyResolved: false,
        auditEventId: auditEvents[0].id,
      });
    }
    case "clinical.actions.listAuditEvents":
      return trpcOk(res, auditEvents.slice(0, Math.min(Number(input.limit ?? 50), 200)));
    default:
      return trpcErr(res, 404, "NOT_FOUND", `unknown procedure ${proc}`);
  }
}).listen(PORT, () => {
  console.log(`[live-stub] contract-fixture backend on http://127.0.0.1:${PORT} — synthetic data, in-memory, NOT the real backend`);
});
