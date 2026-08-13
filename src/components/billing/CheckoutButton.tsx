"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Receipt } from "lucide-react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";

/**
 * Opens checkout for an appointment: creates a DRAFT invoice and goes to it.
 *
 * The draft charges nothing. The server decides what lands on it — the booked
 * service joins automatically only when the appointment type matches an
 * active catalog service by name. An appointment that already has a live
 * invoice is refused, and this button says so rather than making a second one.
 */
export function CheckoutButton({
  patientId,
  appointmentId,
  className,
  label = "Check out",
}: {
  patientId: string;
  appointmentId: string;
  className?: string;
  label?: string;
}) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setWorking(true);
    setError(null);
    try {
      const invoice = await api.billing.createDraft({ patientId, appointmentId });
      router.push(`/billing/${invoice.id}`);
    } catch (e) {
      setError(
        e instanceof AdapterError ? e.message : "Checkout is unavailable right now.",
      );
      setWorking(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={working}
        onClick={() => void start()}
        data-testid="appt-checkout"
        className={className}
      >
        <Receipt size={13} strokeWidth={2} aria-hidden />
        {working ? "Opening…" : label}
      </button>
      {error && (
        <span role="alert" className="text-[11px] font-medium text-critical">
          {error}
        </span>
      )}
    </span>
  );
}
