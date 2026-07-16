import { tasksLive } from "@/adapters/tasks.live";
import { liveGuard, runLive } from "../../route-helpers";

/** GET -> the caller's org review queue (RLS-scoped rows). */
export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(() => tasksLive.getQueue());
}
