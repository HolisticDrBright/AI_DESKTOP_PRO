import {
  CalendarPlus,
  Calendar,
  Check,
  CheckSquare,
  ClipboardList,
  ClipboardPlus,
  Clock,
  ExternalLink,
  FilePlus,
  FlaskConical,
  GitBranch,
  History,
  Home,
  Layers,
  MessageCircle,
  Minus,
  Moon,
  PenLine,
  Plus,
  CircleHelp,
  Sun,
  TestTube,
  Upload,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ActionIcon } from "@/adapters/actions";
import type {
  CommandIcon,
  PracticeStatIcon,
  RailAlertIcon,
} from "@/adapters/types";

export const actionIcons: Record<ActionIcon, LucideIcon> = {
  check: Check,
  pencil: PenLine,
  x: X,
  help: CircleHelp,
  "clipboard-plus": ClipboardPlus,
  "calendar-plus": CalendarPlus,
  message: MessageCircle,
  note: PenLine,
  "file-plus": FilePlus,
  flask: FlaskConical,
  external: ExternalLink,
  history: History,
  plus: Plus,
  minus: Minus,
  "git-branch": GitBranch,
};

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
