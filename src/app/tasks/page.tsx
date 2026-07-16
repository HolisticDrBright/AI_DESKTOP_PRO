import { TasksQueue } from "@/components/tasks/TasksQueue";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filter = typeof sp.filter === "string" ? sp.filter : undefined;
  const priority = typeof sp.priority === "string" ? sp.priority : undefined;
  return <TasksQueue initialCategory={filter} initialPriority={priority} />;
}
