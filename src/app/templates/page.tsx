import { SurfaceScreen } from "@/components/ui/SurfaceScreen";
import { SURFACES } from "@/lib/surfaces";

export default function TemplatesPage() {
  return <SurfaceScreen spec={SURFACES.templates} />;
}
