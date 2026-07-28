"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CircleDot, MapPin, PenLine, RotateCcw, Trash2 } from "lucide-react";
import type {
  BodyMapAnnotation,
  BodyMapPoint,
  BodyMapValue,
} from "@/adapters/charting.mock";
import { cn } from "@/lib/cn";

const WIDTH = 1200;
const HEIGHT = 400;

type Tool = "draw" | "pain" | "acupuncture";

function pathFor(points: BodyMapPoint[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

function position(event: ReactPointerEvent<SVGSVGElement>): BodyMapPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(WIDTH, ((event.clientX - rect.left) / rect.width) * WIDTH)),
    y: Math.max(0, Math.min(HEIGHT, ((event.clientY - rect.top) / rect.height) * HEIGHT)),
  };
}

export function BodyMapField({
  value,
  disabled,
  onChange,
}: {
  value: BodyMapValue | undefined;
  disabled: boolean;
  onChange: (value: BodyMapValue) => void;
}) {
  const annotations = value?.annotations ?? [];
  const [tool, setTool] = useState<Tool>("draw");
  const [color, setColor] = useState("#D14B4B");
  const [pointLabel, setPointLabel] = useState("Ashi");
  const [activeStroke, setActiveStroke] = useState<BodyMapPoint[]>([]);
  const activeStrokeRef = useRef<BodyMapPoint[]>([]);

  const counts = {
    pain: annotations.filter((item) => item.kind === "pain").length,
    acupuncture: annotations.filter((item) => item.kind === "acupuncture").length,
    strokes: annotations.filter((item) => item.kind === "stroke").length,
  };

  const add = (annotation: BodyMapAnnotation) => {
    onChange({ annotations: [...annotations, annotation] });
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled || !event.isPrimary || event.button !== 0) return;
    const point = position(event);
    if (tool === "draw") {
      event.currentTarget.setPointerCapture(event.pointerId);
      const stroke = [point];
      activeStrokeRef.current = stroke;
      setActiveStroke(stroke);
      return;
    }
    add({
      id: `map-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: tool,
      color: tool === "acupuncture" ? "#0D6B73" : color,
      size: tool === "acupuncture" ? 7 : 11,
      points: [point],
      label: pointLabel.trim() || (tool === "acupuncture" ? "Point" : "Pain"),
    });
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled || tool !== "draw" || activeStrokeRef.current.length === 0) return;
    // Capture the coordinate while the React pointer event still owns its SVG target.
    const point = position(event);
    const points = activeStrokeRef.current;
    const previous = points[points.length - 1];
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 2) return;
    const next = [...points, point];
    activeStrokeRef.current = next;
    setActiveStroke(next);
  };

  const finishStroke = (event: ReactPointerEvent<SVGSVGElement>) => {
    const stroke = activeStrokeRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (stroke.length > 1) {
      add({
        id: `map-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: "stroke",
        color,
        size: 6,
        points: stroke,
      });
    }
    activeStrokeRef.current = [];
    setActiveStroke([]);
  };

  const cancelStroke = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activeStrokeRef.current = [];
    setActiveStroke([]);
  };

  const toolButton = (value: Tool) => cn(
    "flex h-8 items-center gap-[6px] rounded-lg border px-[9px] text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
    tool === value ? "border-action bg-action-tint text-action-deep" : "border-line bg-card text-body hover:border-line-hover",
  );

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-card">
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-sunken px-3 py-2">
          <button type="button" className={toolButton("draw")} onClick={() => setTool("draw")} aria-pressed={tool === "draw"}>
            <PenLine size={13} aria-hidden /> Draw area
          </button>
          <button type="button" className={toolButton("pain")} onClick={() => { setTool("pain"); setPointLabel("Pain"); }} aria-pressed={tool === "pain"}>
            <MapPin size={13} aria-hidden /> Pain point
          </button>
          <button type="button" className={toolButton("acupuncture")} onClick={() => { setTool("acupuncture"); setPointLabel("Ashi"); }} aria-pressed={tool === "acupuncture"}>
            <CircleDot size={13} aria-hidden /> Acupuncture point
          </button>
          <label className="ml-auto flex items-center gap-1 text-[10.5px] font-semibold text-subtle">
            Color
            <input type="color" value={color} onChange={(event) => setColor(event.target.value)} className="h-7 w-8 cursor-pointer rounded border border-line bg-card p-px" aria-label="Annotation color" />
          </label>
          {tool !== "draw" && (
            <label className="flex items-center gap-1 text-[10.5px] font-semibold text-subtle">
              Label
              <input value={pointLabel} onChange={(event) => setPointLabel(event.target.value)} className="h-7 w-[88px] rounded-md border border-line bg-card px-2 text-[11px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action" aria-label="Point label" />
            </label>
          )}
          <button type="button" onClick={() => onChange({ annotations: annotations.slice(0, -1) })} disabled={annotations.length === 0} className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card text-muted hover:border-line-hover disabled:opacity-40" aria-label="Undo last body-map annotation">
            <RotateCcw size={13} aria-hidden />
          </button>
          <button type="button" onClick={() => onChange({ annotations: [] })} disabled={annotations.length === 0} className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card text-critical hover:border-critical disabled:opacity-40" aria-label="Clear body map">
            <Trash2 size={13} aria-hidden />
          </button>
        </div>
      )}

      <div
        className="relative aspect-[3/1] min-h-[210px] w-full bg-white bg-contain bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/clinical/body-chart-neutral.png')" }}
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className={cn("absolute inset-0 h-full w-full touch-none", disabled ? "cursor-default" : tool === "draw" ? "cursor-crosshair" : "cursor-cell")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={cancelStroke}
          aria-label="Interactive clinical body map"
          role="img"
        >
          {annotations.map((annotation) => annotation.kind === "stroke" ? (
            <path key={annotation.id} d={pathFor(annotation.points)} fill="none" stroke={annotation.color} strokeWidth={annotation.size} strokeLinecap="round" strokeLinejoin="round" opacity="0.82" />
          ) : (
            <g key={annotation.id}>
              <circle cx={annotation.points[0]?.x} cy={annotation.points[0]?.y} r={annotation.size} fill={annotation.color} opacity="0.9" />
              <circle cx={annotation.points[0]?.x} cy={annotation.points[0]?.y} r={annotation.size + 4} fill="none" stroke={annotation.color} strokeWidth="2" opacity="0.5" />
              <text x={(annotation.points[0]?.x ?? 0) + annotation.size + 7} y={(annotation.points[0]?.y ?? 0) - 7} fill="#182A3D" fontSize="18" fontWeight="700" paintOrder="stroke" stroke="white" strokeWidth="5">{annotation.label}</text>
            </g>
          ))}
          {activeStroke.length > 1 && <path d={pathFor(activeStroke)} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" opacity="0.82" />}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-hairline px-3 py-2 text-[10.5px] text-subtle">
        <span>{counts.strokes} drawn area{counts.strokes === 1 ? "" : "s"}</span>
        <span>{counts.pain} pain point{counts.pain === 1 ? "" : "s"}</span>
        <span>{counts.acupuncture} acupuncture / ashi point{counts.acupuncture === 1 ? "" : "s"}</span>
        {!disabled && <span className="ml-auto">Select a tool, then draw or click directly on the body.</span>}
      </div>
    </div>
  );
}
