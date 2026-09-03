import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { patientsLive } from "@/adapters/patients.live";
import type { CreatePatientInput } from "@/adapters/types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const SEX_VALUES = new Set<CreatePatientInput["sex"]>([
  "male",
  "female",
  "other",
  "unknown",
]);

function optionalString(value: unknown, max: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > max) {
    throw new AdapterError("invalid", "One or more patient fields are invalid.");
  }
  return value.trim();
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
    throw new AdapterError("invalid", "First and last name are required.");
  }
  return value.trim();
}

/** Creates one tenant-scoped patient through the governed database RPC. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;

  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const syntheticOnly =
      process.env.APP_RUNTIME_ENV === "staging" ||
      process.env.CLINICAL_DATA_PLANE === "supabase_staging";

    if (syntheticOnly && body.attestsSynthetic !== true) {
      throw new AdapterError(
        "invalid",
        "Confirm that this record contains synthetic test information only.",
      );
    }

    const session = await getRequestSession();
    if (syntheticOnly) {
      return patientsLive.create(
        {
          firstName: "Synthetic",
          lastName: "link-test",
          dateOfBirth: null,
          sex: "unknown",
          mrn: null,
          email: null,
          phone: null,
          attestsSynthetic: true,
        },
        session.token,
        session.orgId,
      );
    }

    const sex = body.sex;
    if (typeof sex !== "string" || !SEX_VALUES.has(sex as CreatePatientInput["sex"])) {
      throw new AdapterError("invalid", "Select a valid recorded sex value.");
    }

    const dateOfBirth = optionalString(body.dateOfBirth, 10);
    if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
      throw new AdapterError("invalid", "Enter the date of birth as YYYY-MM-DD.");
    }

    return patientsLive.create(
      {
        firstName: requiredString(body.firstName),
        lastName: requiredString(body.lastName),
        dateOfBirth,
        sex: sex as CreatePatientInput["sex"],
        mrn: optionalString(body.mrn, 64),
        email: optionalString(body.email, 320),
        phone: optionalString(body.phone, 40),
        attestsSynthetic: body.attestsSynthetic === true,
      },
      session.token,
      session.orgId,
    );
  });
}
