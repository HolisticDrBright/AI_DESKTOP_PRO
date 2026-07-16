import type { Tone } from "./types";

/**
 * MOCK connector-health data. Synthetic; shaped like a future
 * `api.integrations.getConnectors` tRPC query. Error strings are SAFE
 * summaries — never raw payloads, tokens, or PHI.
 */

export type ConnectorStatus = "Connected" | "Degraded" | "Error" | "Not configured";

export const CONNECTOR_STATUS_TONE: Record<ConnectorStatus, Tone> = {
  Connected: "positive",
  Degraded: "warning",
  Error: "critical",
  "Not configured": "slate",
};

export interface ConnectorCard {
  id: string;
  name: string;
  purpose: string;
  status: ConnectorStatus;
  lastSync: string;
  nextSync: string;
  scopes: string[];
  safeError?: string;
}

export function getConnectors(): ConnectorCard[] {
  return [
    { id: "alp-mobile", name: "ALP mobile app", purpose: "Patient check-ins, symptoms, habits", status: "Not configured", lastSync: "—", nextSync: "After identity cutover (ADR 0002)", scopes: ["check-ins:read", "habits:read"] },
    { id: "fullscript", name: "Fullscript", purpose: "Supplement dispensary + refills", status: "Not configured", lastSync: "—", nextSync: "—", scopes: ["catalog:read", "orders:write"] },
    { id: "labs", name: "Labs provider", purpose: "Lab orders + results ingestion", status: "Degraded", lastSync: "Jul 15, 22:10", nextSync: "Hourly", scopes: ["results:read", "orders:write"], safeError: "2 documents pending OCR retry (provider throttling). No data loss." },
    { id: "vital", name: "Vital (wearables)", purpose: "Oura / device data pipeline", status: "Connected", lastSync: "Jul 16, 07:02", nextSync: "Every 15 min", scopes: ["sleep:read", "activity:read", "hrv:read"] },
    { id: "stripe", name: "Stripe", purpose: "Payments + invoices", status: "Not configured", lastSync: "—", nextSync: "—", scopes: ["charges:write", "invoices:write"] },
    { id: "claim-md", name: "Claim.MD", purpose: "Insurance claims clearinghouse", status: "Not configured", lastSync: "—", nextSync: "—", scopes: ["claims:write", "status:read"] },
    { id: "telehealth", name: "Telehealth provider", purpose: "Video visit links on appointments", status: "Connected", lastSync: "Jul 16, 06:45", nextSync: "On booking", scopes: ["meetings:write"] },
    { id: "quantum-mind", name: "Quantum Mind", purpose: "Guided session assignments", status: "Connected", lastSync: "Jul 15, 21:30", nextSync: "Daily", scopes: ["sessions:assign", "completion:read"] },
  ];
}
