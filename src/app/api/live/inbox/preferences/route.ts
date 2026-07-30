import { NextRequest } from "next/server";
import { inboxLive } from "@/adapters/inbox.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — upsert patient communication preferences + consent link. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      patientId?: unknown;
      preferredChannel?: unknown;
      emailOk?: unknown;
      smsOk?: unknown;
      pushOk?: unknown;
      doNotContact?: unknown;
      consentId?: unknown;
      note?: unknown;
    };
    if (typeof b.patientId !== "string" || !b.patientId) {
      throw new Error("patientId is required");
    }
    const preferred =
      b.preferredChannel === "email" || b.preferredChannel === "sms" || b.preferredChannel === "none"
        ? b.preferredChannel
        : "in_app";
    const session = await getRequestSession();
    return inboxLive.setPreferences(
      {
        patientId: b.patientId,
        preferredChannel: preferred,
        emailOk: b.emailOk === true,
        smsOk: b.smsOk === true,
        pushOk: b.pushOk === true,
        doNotContact: b.doNotContact === true,
        consentId: typeof b.consentId === "string" ? b.consentId : null,
        note: typeof b.note === "string" ? b.note : null,
      },
      session.token,
    );
  });
}
