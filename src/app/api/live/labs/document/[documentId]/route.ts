import { NextRequest, NextResponse } from "next/server";
import { TRPC_BASE_URL } from "@/adapters/config";
import { AdapterError } from "@/adapters/errors";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { getRequestSession } from "@/server/session";
import { liveGuard } from "../../../route-helpers";

const UUID_RE = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * GET -> stream the ORIGINAL stored lab PDF from the backend, as the signed-in
 * practitioner. Authorization happens in the backend + database (RLS on the
 * document row and on the storage object path); the view is audited there.
 * Binary passthrough — this route never parses or logs document content.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ documentId: string }> },
) {
  const blocked = liveGuard();
  if (blocked) return blocked;

  const { documentId } = await ctx.params;
  if (!UUID_RE.test(documentId)) {
    return NextResponse.json(
      { error: { code: "invalid", message: "A document id is required." } },
      { status: 400 },
    );
  }

  let token: string;
  try {
    const session = await getRequestSession();
    token = await getClinicalAccessToken(session.token);
  } catch (e) {
    const code = e instanceof AdapterError ? e.code : "unavailable";
    const message = e instanceof AdapterError ? e.safeMessage : "Sign in to open source documents.";
    return NextResponse.json({ error: { code, message } }, { status: code === "unauthenticated" ? 401 : 502 });
  }

  const base = TRPC_BASE_URL.replace(/\/api\/trpc\/?$/, "");
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/clinical/labs/document/${documentId}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: { code: "unavailable", message: "The document service is unreachable." } },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    // Upstream errors are JSON envelopes — pass them through untouched.
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/pdf",
      "content-disposition": 'inline; filename="lab-document.pdf"',
      "cache-control": "no-store",
    },
  });
}
