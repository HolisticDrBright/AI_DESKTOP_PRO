"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, X } from "lucide-react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type { CreatePatientInput } from "@/adapters/types";
import { Btn } from "@/components/ui/Btn";
import { patientPath } from "@/lib/routes";

const INPUT =
  "h-9 w-full rounded-lg border border-line bg-card px-3 text-[13px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const LABEL = "mb-1 block text-[11px] font-bold text-subtle";

function errorMessage(error: unknown): string {
  if (error instanceof AdapterError) return error.safeMessage;
  return "The patient could not be created. Try again.";
}

export function AddPatientDialog({ syntheticOnly }: { syntheticOnly: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<CreatePatientInput>({
    firstName: "",
    lastName: "",
    dateOfBirth: null,
    sex: "unknown",
    mrn: null,
    email: null,
    phone: null,
    attestsSynthetic: false,
  });

  const set = <K extends keyof CreatePatientInput>(key: K, value: CreatePatientInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!syntheticOnly && (!form.firstName.trim() || !form.lastName.trim())) {
      setError("Enter a first and last name.");
      return;
    }
    if (syntheticOnly && !form.attestsSynthetic) {
      setError("Confirm that this is a synthetic test record.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api.patients.create(
        syntheticOnly
          ? {
              firstName: "Synthetic",
              lastName: "link-test",
              dateOfBirth: null,
              sex: "unknown",
              mrn: null,
              email: null,
              phone: null,
              attestsSynthetic: true,
            }
          : form,
      );
      setOpen(false);
      router.push(patientPath(result.patient.id, syntheticOnly ? "app-sync" : "chart"));
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <>
      <Btn variant="primary" onClick={() => setOpen(true)} data-testid="add-patient-open">
        <UserPlus size={14} strokeWidth={2} aria-hidden /> {syntheticOnly ? "Add test patient" : "Add patient"}
      </Btn>

      {open && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center bg-[rgba(24,42,61,0.32)] px-4 backdrop-blur-[3px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-patient-title"
            className="max-h-[calc(100vh-32px)] w-full max-w-[620px] overflow-y-auto rounded-lg border border-line bg-card shadow-[0_18px_60px_rgba(24,42,61,0.2)]"
            data-testid="add-patient-dialog"
          >
            <div className="flex items-start justify-between border-b border-line px-5 py-4">
              <div>
                <h2 id="add-patient-title" className="m-0 text-[17px] font-bold text-ink">
                  {syntheticOnly ? "Create test chart" : "Add patient"}
                </h2>
                <p className="mt-1 mb-0 text-[12px] text-subtle">
                  {syntheticOnly
                    ? "Create an anonymous chart, then continue directly to its patient-app connection."
                    : "Create the chart first, then connect the patient app with a one-time invitation."}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close add patient dialog"
                title="Close"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted hover:bg-sunken focus-visible:outline-2 focus-visible:outline-action disabled:cursor-not-allowed"
              >
                <X size={17} aria-hidden />
              </button>
            </div>

            <form onSubmit={(event) => void submit(event)}>
              <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
                {syntheticOnly && (
                  <div className="sm:col-span-2 rounded-lg border border-warning/35 bg-warning-tint px-3 py-2.5 text-[12px] leading-5 text-warning-deep">
                    <strong>Synthetic staging only.</strong> This creates an anonymous test chart with a generated label. No name, date of birth, email, phone number, or medical information is requested or stored.
                  </div>
                )}

                {!syntheticOnly && <label>
                  <span className={LABEL}>First name *</span>
                  <input
                    className={INPUT}
                    value={form.firstName}
                    maxLength={100}
                    autoComplete="off"
                    onChange={(event) => set("firstName", event.target.value)}
                    data-testid="add-patient-first-name"
                  />
                </label>}
                {!syntheticOnly && <label>
                  <span className={LABEL}>Last name *</span>
                  <input
                    className={INPUT}
                    value={form.lastName}
                    maxLength={100}
                    autoComplete="off"
                    onChange={(event) => set("lastName", event.target.value)}
                    data-testid="add-patient-last-name"
                  />
                </label>}
                {!syntheticOnly && <label>
                  <span className={LABEL}>Date of birth</span>
                  <input
                    type="date"
                    className={INPUT}
                    value={form.dateOfBirth ?? ""}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={(event) => set("dateOfBirth", event.target.value || null)}
                    data-testid="add-patient-dob"
                  />
                </label>}
                {!syntheticOnly && <label>
                  <span className={LABEL}>Recorded sex</span>
                  <select
                    className={INPUT}
                    value={form.sex}
                    onChange={(event) => set("sex", event.target.value as CreatePatientInput["sex"])}
                    data-testid="add-patient-sex"
                  >
                    <option value="unknown">Unknown</option>
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                    <option value="other">Other</option>
                  </select>
                </label>}
                {!syntheticOnly && <label>
                  <span className={LABEL}>MRN</span>
                  <input
                    className={INPUT}
                    value={form.mrn ?? ""}
                    maxLength={64}
                    autoComplete="off"
                    placeholder="Optional"
                    onChange={(event) => set("mrn", event.target.value || null)}
                    data-testid="add-patient-mrn"
                  />
                </label>}
                {!syntheticOnly && <div className="hidden sm:block" aria-hidden />}
                {!syntheticOnly && <label>
                  <span className={LABEL}>Email</span>
                  <input
                    type="email"
                    className={INPUT}
                    value={form.email ?? ""}
                    maxLength={320}
                    autoComplete="off"
                    placeholder="Optional"
                    onChange={(event) => set("email", event.target.value || null)}
                    data-testid="add-patient-email"
                  />
                </label>}
                {!syntheticOnly && <label>
                  <span className={LABEL}>Phone</span>
                  <input
                    type="tel"
                    className={INPUT}
                    value={form.phone ?? ""}
                    maxLength={40}
                    autoComplete="off"
                    placeholder="Optional"
                    onChange={(event) => set("phone", event.target.value || null)}
                    data-testid="add-patient-phone"
                  />
                </label>}

                {syntheticOnly && (
                  <label className="sm:col-span-2 flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-sunken px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-action"
                      checked={form.attestsSynthetic === true}
                      onChange={(event) => set("attestsSynthetic", event.target.checked)}
                      data-testid="add-patient-synthetic"
                    />
                    <span className="text-[12px] leading-5 text-body">
                      I confirm this chart contains synthetic test information only.
                    </span>
                  </label>
                )}

                {error && (
                  <p role="alert" className="sm:col-span-2 m-0 text-[12px] font-semibold text-critical" data-testid="add-patient-error">
                    {error}
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
                <Btn type="button" disabled={busy} onClick={() => setOpen(false)}>
                  Cancel
                </Btn>
                <Btn type="submit" variant="primary" disabled={busy} data-testid="add-patient-submit">
                  <UserPlus size={14} strokeWidth={2} aria-hidden />
                  {busy ? "Creating…" : syntheticOnly ? "Create and connect" : "Create patient"}
                </Btn>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
