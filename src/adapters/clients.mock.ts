import { listPatients } from "./patients.mock";
import type { Priority } from "./types";

/**
 * MOCK client directory rows. Derived from the shared synthetic patient
 * directory so links stay coherent. Shaped like a future `api.clients.list`
 * tRPC query.
 */

export interface ClientRow {
  patientId: string;
  name: string;
  initials: string;
  avatarGradient: [string, string];
  tags: string[];
  program: string;
  practitioner: string;
  status: "Active" | "Onboarding" | "Paused";
  risk: "Low" | "Moderate" | "Elevated";
  lastContact: string;
  lastLab: string;
  adherencePct: number;
  activeExperiment: string | null;
  nextAppointment: string;
  tasksDue: number;
  priority: Priority;
}

const EXTRA: Record<string, Omit<ClientRow, "patientId" | "name" | "initials" | "avatarGradient">> = {
  "p-78435": { tags: ["Longevity", "Sleep"], program: "Foundations 12-week", practitioner: "Dr. Sarah Mitchell", status: "Active", risk: "Moderate", lastContact: "Jul 12", lastLab: "May 13", adherencePct: 88, activeExperiment: "Morning light", nextAppointment: "Jul 21, 10:00", tasksDue: 3, priority: "High" },
  "p-64201": { tags: ["Metabolic"], program: "Metabolic reset", practitioner: "Dr. Sarah Mitchell", status: "Active", risk: "Elevated", lastContact: "Jul 10", lastLab: "Jun 30", adherencePct: 46, activeExperiment: "Post-dinner walk", nextAppointment: "Jul 24, 14:30", tasksDue: 4, priority: "High" },
  "p-59318": { tags: ["Fatigue", "Iron"], program: "Foundations 12-week", practitioner: "Dr. Sarah Mitchell", status: "Active", risk: "Elevated", lastContact: "Jul 14", lastLab: "Jul 8", adherencePct: 91, activeExperiment: "Iron protocol", nextAppointment: "Jul 17, 9:30", tasksDue: 2, priority: "High" },
  "p-71126": { tags: ["Sleep", "Strength"], program: "Performance", practitioner: "Health Coach", status: "Active", risk: "Low", lastContact: "Jul 2", lastLab: "Jul 2", adherencePct: 94, activeExperiment: "Creatine", nextAppointment: "Aug 12, 11:00", tasksDue: 1, priority: "Low" },
  "p-52984": { tags: ["Metabolic"], program: "Metabolic reset", practitioner: "Health Coach", status: "Paused", risk: "Elevated", lastContact: "Jul 6", lastLab: "Jun 24", adherencePct: 38, activeExperiment: null, nextAppointment: "Jul 29, 15:00", tasksDue: 3, priority: "High" },
  "p-66473": { tags: ["Stress"], program: "Foundations 12-week", practitioner: "Dr. Sarah Mitchell", status: "Active", risk: "Moderate", lastContact: "Jul 1", lastLab: "Jul 1", adherencePct: 76, activeExperiment: "Breathwork", nextAppointment: "Aug 5, 13:00", tasksDue: 1, priority: "Medium" },
};

export function getClientRows(): ClientRow[] {
  return listPatients().map((p) => ({
    patientId: p.id,
    name: p.name,
    initials: p.initials,
    avatarGradient: p.avatarGradient,
    ...EXTRA[p.id],
  }));
}
