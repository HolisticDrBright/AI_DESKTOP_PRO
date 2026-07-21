"use client";

import { useRef, useState } from "react";
import {
  Circle,
  Eraser,
  MousePointer2,
  Pencil,
  Redo2,
  Trash2,
  Undo2,
} from "lucide-react";
import type { BodyChartField, BodyChartValue, BodyOp, BodyView } from "@/adapters/charting.mock";
import { FieldLabel } from "./ChartFields";
import { cn } from "@/lib/cn";

/* viewBox units — drawings are stored normalized (0..1) and scaled to this. */
const VB_W = 200;
const VB_H = 460;

const COLORS = ["#182a3d", "#2563c7", "#d6544a", "#1f9d63", "#7461c9"];

type Tool = "select" | "pencil" | "point" | "erase";

/* Stylized humanoid silhouette, symmetric about x=100. Right-half boundary
 * points (neck → outer arm → hand → inner arm → torso → leg → crotch); the
 * left half is mirrored, so one array defines the whole figure. */
const RIGHT_HALF: [number, number][] = [
  [110, 66], [128, 74], [150, 86], [165, 100], [170, 120], [172, 170],
  [174, 214], [176, 244], [178, 262], [166, 266], [158, 244], [152, 210],
  [148, 150], [142, 128], [132, 150], [126, 196], [126, 214], [144, 236],
  [142, 288], [138, 330], [134, 388], [130, 430], [132, 448], [150, 452],
  [150, 458], [110, 458], [110, 452], [112, 430], [110, 388], [106, 330],
  [104, 288], [100, 262],
];

function bodyPath(): string {
  // Down the right side, then up the mirrored left side, closed under the chin.
  const right = RIGHT_HALF;
  const left = [...right].reverse().map(([x, y]) => [VB_W - x, y] as [number, number]);
  const d = [`M ${VB_W - 110} 66`, `L 110 66`];
  for (const [x, y] of right) d.push(`L ${x} ${y}`);
  for (const [x, y] of left) d.push(`L ${x} ${y}`);
  d.push("Z");
  return d.join(" ");
}

const BODY_PATH = bodyPath();

function Silhouette({ view }: { view: BodyView }) {
  return (
    <g>
      {/* head */}
      <ellipse cx={100} cy={38} rx={24} ry={28} fill="#fff" stroke="#c9d6e3" strokeWidth={1.6} />
      {/* body */}
      <path d={BODY_PATH} fill="#fff" stroke="#c9d6e3" strokeWidth={1.6} strokeLinejoin="round" />
      {view === "back" ? (
        <>
          {/* spine + shoulder blades hint */}
          <line x1={100} y1={92} x2={100} y2={250} stroke="#e4eaf1" strokeWidth={1.4} />
          <path d="M78 118 q10 12 0 26" fill="none" stroke="#e4eaf1" strokeWidth={1.2} />
          <path d="M122 118 q-10 12 0 26" fill="none" stroke="#e4eaf1" strokeWidth={1.2} />
        </>
      ) : (
        <>
          {/* centre line + collarbone hint */}
          <line x1={100} y1={92} x2={100} y2={250} stroke="#eef2f7" strokeWidth={1.2} />
          <path d="M82 96 q18 10 36 0" fill="none" stroke="#eef2f7" strokeWidth={1.2} />
        </>
      )}
    </g>
  );
}

function BodyCanvas({
  view,
  ops,
  tool,
  color,
  label,
  onCommit,
  onErase,
  readOnly,
}: {
  view: BodyView;
  ops: BodyOp[];
  tool: Tool;
  color: string;
  label: string;
  onCommit: (op: BodyOp) => void;
  onErase: (index: number) => void;
  readOnly?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  // The in-progress stroke lives in a ref (not state) so rapid pointer moves
  // never read a stale buffer and drop points; `tick` only forces a re-render
  // of the live preview.
  const draftRef = useRef<[number, number][] | null>(null);
  const [, setTick] = useState(0);
  const draft = draftRef.current;
  const viewOps = ops
    .map((op, index) => ({ op, index }))
    .filter(({ op }) => op.view === view);

  function toNorm(e: React.PointerEvent): [number, number] {
    const rect = ref.current!.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    ];
  }

  function nearestOpIndex([nx, ny]: [number, number]): number | null {
    let best: number | null = null;
    let bestD = 0.05 * 0.05; // ~5% radius
    for (const { op, index } of viewOps) {
      const probe: [number, number][] =
        op.kind === "point" ? [[op.x, op.y]] : op.pts;
      for (const [px, py] of probe) {
        const d = (px - nx) ** 2 + (py - ny) ** 2;
        if (d < bestD) {
          bestD = d;
          best = index;
        }
      }
    }
    return best;
  }

  function onDown(e: React.PointerEvent) {
    if (readOnly || tool === "select") return;
    e.preventDefault();
    const p = toNorm(e);
    if (tool === "pencil") {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      draftRef.current = [p];
      setTick((t) => t + 1);
    } else if (tool === "point") {
      onCommit({ kind: "point", view, color, x: p[0], y: p[1], label });
    } else if (tool === "erase") {
      const idx = nearestOpIndex(p);
      if (idx !== null) onErase(idx);
    }
  }

  function onMove(e: React.PointerEvent) {
    if (!draftRef.current) return;
    draftRef.current.push(toNorm(e));
    setTick((t) => t + 1);
  }

  function onUp() {
    const pts = draftRef.current;
    draftRef.current = null;
    if (pts && pts.length > 1) {
      onCommit({ kind: "stroke", view, color, width: 3, pts });
    }
    setTick((t) => t + 1);
  }

  const cursor =
    readOnly || tool === "select" ? "default" : tool === "erase" ? "cell" : "crosshair";

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      className="h-[360px] w-auto touch-none select-none"
      style={{ cursor }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    >
      <Silhouette view={view} />
      {viewOps.map(({ op, index }) =>
        op.kind === "stroke" ? (
          <polyline
            key={index}
            points={op.pts.map(([x, y]) => `${x * VB_W},${y * VB_H}`).join(" ")}
            fill="none"
            stroke={op.color}
            strokeWidth={op.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <g key={index}>
            <circle cx={op.x * VB_W} cy={op.y * VB_H} r={4} fill={op.color} stroke="#fff" strokeWidth={1.2} />
            {op.label && (
              <text
                x={op.x * VB_W + 6}
                y={op.y * VB_H + 3}
                fontSize={10}
                fontWeight={700}
                fill={op.color}
              >
                {op.label}
              </text>
            )}
          </g>
        ),
      )}
      {draft && (
        <polyline
          points={draft.map(([x, y]) => `${x * VB_W},${y * VB_H}`).join(" ")}
          fill="none"
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function BodyChartInput({
  field,
  value,
  onChange,
  readOnly,
}: {
  field: BodyChartField;
  value: BodyChartValue;
  onChange: (next: BodyChartValue) => void;
  readOnly?: boolean;
}) {
  const [tool, setTool] = useState<Tool>("pencil");
  const [color, setColor] = useState(COLORS[0]);
  const [label, setLabel] = useState("");
  const [redo, setRedo] = useState<BodyOp[]>([]);
  const ops = value.ops ?? [];

  const commit = (op: BodyOp) => {
    onChange({ ops: [...ops, op] });
    setRedo([]);
  };
  const eraseAt = (index: number) => {
    onChange({ ops: ops.filter((_, i) => i !== index) });
    setRedo([]);
  };
  const undo = () => {
    if (!ops.length) return;
    const last = ops[ops.length - 1];
    onChange({ ops: ops.slice(0, -1) });
    setRedo((r) => [...r, last]);
  };
  const redoOp = () => {
    if (!redo.length) return;
    const op = redo[redo.length - 1];
    onChange({ ops: [...ops, op] });
    setRedo((r) => r.slice(0, -1));
  };
  const clear = () => {
    onChange({ ops: [] });
    setRedo([]);
  };

  const tools: { id: Tool; icon: typeof Pencil; title: string }[] = [
    { id: "select", icon: MousePointer2, title: "Select" },
    { id: "pencil", icon: Pencil, title: "Draw" },
    { id: "point", icon: Circle, title: "Place acupoint" },
    { id: "erase", icon: Eraser, title: "Erase nearest mark" },
  ];

  return (
    <div>
      {field.label && <FieldLabel>{field.label}</FieldLabel>}
      <div className="flex gap-3 rounded-[12px] border border-line bg-sunken p-3">
        {/* toolbar */}
        {!readOnly && (
          <div className="flex flex-col items-center gap-[6px]">
            {tools.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  title={t.title}
                  aria-pressed={tool === t.id}
                  onClick={() => setTool(t.id)}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-[8px] border focus-visible:outline-2 focus-visible:outline-action",
                    tool === t.id
                      ? "border-action bg-action text-white"
                      : "border-line-btn bg-card text-muted hover:text-ink",
                  )}
                >
                  <Icon size={15} strokeWidth={2} aria-hidden />
                </button>
              );
            })}
            <div className="my-[2px] h-px w-6 bg-line" />
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                title="Colour"
                aria-label={`Colour ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cn(
                  "h-[18px] w-[18px] rounded-full border-2",
                  color === c ? "border-action" : "border-white",
                )}
                style={{ background: c }}
              />
            ))}
            <div className="my-[2px] h-px w-6 bg-line" />
            <button type="button" title="Undo" onClick={undo} className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-line-btn bg-card text-muted hover:text-ink disabled:opacity-40" disabled={!ops.length}>
              <Undo2 size={15} aria-hidden />
            </button>
            <button type="button" title="Redo" onClick={redoOp} className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-line-btn bg-card text-muted hover:text-ink disabled:opacity-40" disabled={!redo.length}>
              <Redo2 size={15} aria-hidden />
            </button>
            <button type="button" title="Clear all" onClick={clear} className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-line-btn bg-card text-muted hover:text-critical disabled:opacity-40" disabled={!ops.length}>
              <Trash2 size={15} aria-hidden />
            </button>
          </div>
        )}
        {/* canvases */}
        <div className="min-w-0 flex-1">
          {tool === "point" && !readOnly && (
            <div className="mb-2 flex items-center gap-2">
              <label className="text-[11px] font-semibold text-muted">Point label</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. LI4, Ashi"
                className="h-7 w-32 rounded-[7px] border border-line bg-card px-2 text-[12px] focus-visible:border-action focus-visible:outline-none"
              />
              <span className="text-[11px] text-faint">Click the body to place a pin.</span>
            </div>
          )}
          <div className="flex flex-wrap items-start justify-center gap-4 overflow-x-auto rounded-[10px] border border-line bg-card p-2">
            {field.views.map((view) => (
              <div key={view} className="flex flex-col items-center">
                <BodyCanvas
                  view={view}
                  ops={ops}
                  tool={tool}
                  color={color}
                  label={label}
                  onCommit={commit}
                  onErase={eraseAt}
                  readOnly={readOnly}
                />
                <span className="text-[10px] font-semibold tracking-wide text-faint uppercase">
                  {view}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
