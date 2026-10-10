import { AdapterError } from "@/adapters/errors";

/** The viewer's calendar context every telehealth action carries: the day and the IANA zone it was shown in. */
export function dayContext(params: URLSearchParams): { date: string; timeZone: string } {
  return { date: params.get("date") ?? "", timeZone: params.get("timeZone") ?? "" };
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AdapterError("invalid", "A JSON body is required.");
  return body as Record<string, unknown>;
}
