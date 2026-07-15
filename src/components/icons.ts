import {
  Calendar,
  CheckSquare,
  ClipboardList,
  Clock,
  FlaskConical,
  GitBranch,
  Home,
  Layers,
  Moon,
  PenLine,
  Sun,
  TestTube,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";
import type {
  CommandIcon,
  PracticeStatIcon,
  RailAlertIcon,
} from "@/adapters/types";

export const railAlertIcons: Record<RailAlertIcon, LucideIcon> = {
  flask: FlaskConical,
  clipboard: ClipboardList,
  moon: Moon,
  sun: Sun,
};

export const practiceStatIcons: Record<PracticeStatIcon, LucideIcon> = {
  users: Users,
  tasks: CheckSquare,
  flask: FlaskConical,
  layers: Layers,
  clock: Clock,
  calendar: Calendar,
};

export const commandIcons: Record<CommandIcon, LucideIcon> = {
  note: PenLine,
  upload: Upload,
  tube: TestTube,
  home: Home,
  users: Users,
  reasoning: GitBranch,
};
