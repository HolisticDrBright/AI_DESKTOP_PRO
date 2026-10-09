/** A lost creation response is not proof that the encounter was not created. */
export type EncounterStartResult =
  | { kind: "ready"; href: string }
  | { kind: "refused" }
  | { kind: "unconfirmed" };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function requestEncounterStart(
  input: { patientId: string; visitType: string; appointmentId?: string },
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<EncounterStartResult> {
  if (!UUID.test(input.patientId) || (input.appointmentId && !UUID.test(input.appointmentId))) return { kind: "refused" };
  if (signal.aborted) return { kind: "unconfirmed" };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 12_000);
  let onAbort = () => {};
  const interrupted = new Promise<EncounterStartResult>(resolve => {
    onAbort = () => resolve({ kind: "unconfirmed" });
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const work = (async (): Promise<EncounterStartResult> => {
      const response = await fetchImpl("/api/live/emr/encounter", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(input), signal: controller.signal,
      });
      if (response.status >= 400 && response.status < 500) return { kind: "refused" };
      if (!response.ok) return { kind: "unconfirmed" };
      const json = await response.json();
      const id: unknown = json?.data?.encounterId;
      if (typeof id !== "string" || !UUID.test(id)) return { kind: "unconfirmed" };
      return { kind: "ready", href: `/patients/${input.patientId}/encounter/${id}` };
    })().catch((): EncounterStartResult => ({ kind: "unconfirmed" }));
    return await Promise.race([work, interrupted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
