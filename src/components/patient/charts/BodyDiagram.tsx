"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Pencil, Redo2, Trash2, Undo2 } from "lucide-react";
import type { BodyPose, Stroke } from "@/adapters/charts.mock";
import { cn } from "@/lib/cn";
import { BodyFigures } from "./BodyFigure";

const COLORS = [
  { id: "ink", value: "#182a3d", label: "Black" },
  { id: "red", value: "#d6544a", label: "Red" },
  { id: "teal", value: "#0e8388", label: "Teal" },
];

const SIZES = [
  { id: "s", width: 2, dot: 4 },
  { id: "m", width: 4, dot: 8 },
  { id: "l", width: 7, dot: 13 },
];

type Tool = "pencil" | "eraser";

function drawStrokes(canvas: HTMLCanvasElement, strokes: Stroke[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const dpr = canvas.width / canvas.clientWidth || 1;
  for (const s of strokes) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.size * dpr;
    if (s.points.length === 2) {
      ctx.beginPath();
      ctx.arc(s.points[0] * width, s.points[1] * height, (s.size * dpr) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(s.points[0] * width, s.points[1] * height);
    for (let i = 2; i < s.points.length; i += 2) {
      ctx.lineTo(s.points[i] * width, s.points[i + 1] * height);
    }
    ctx.stroke();
  }
}

export function BodyDiagram({
  value,
  onChange,
  poses,
  disabled,
}: {
  value: Stroke[];
  onChange: (strokes: Stroke[]) => void;
  poses: BodyPose[];
  disabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const drawing = useRef<Stroke | null>(null);
  const [tool, setTool] = useState<Tool>("pencil");
  const [color, setColor] = useState(COLORS[0].value);
  const [size, setSize] = useState(SIZES[1].width);
  const [redo, setRedo] = useState<Stroke[]>([]);

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const surface = surfaceRef.current;
    if (!canvas || !surface) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = surface.clientWidth * dpr;
    canvas.height = surface.clientHeight * dpr;
    drawStrokes(canvas, value);
  }, [value]);

  useEffect(() => {
    resize();
    const ro = new ResizeObserver(resize);
    if (surfaceRef.current) ro.observe(surfaceRef.current);
    return () => ro.disconnect();
  }, [resize]);

  useEffect(() => {
    if (canvasRef.current) drawStrokes(canvasRef.current, value);
  }, [value]);

  const pointAt = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    ] as const;
  };

  const eraseAt = (nx: number, ny: number) => {
    const threshold = 0.03;
    const kept = value.filter((s) => {
      for (let i = 0; i < s.points.length; i += 2) {
        const dx = s.points[i] - nx;
        const dy = s.points[i + 1] - ny;
        if (Math.hypot(dx, dy) < threshold) return false;
      }
      return true;
    });
    if (kept.length !== value.length) onChange(kept);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const [nx, ny] = pointAt(e);
    if (tool === "eraser") {
      eraseAt(nx, ny);
      return;
    }
    drawing.current = { color, size, points: [nx, ny] };
    setRedo([]);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (disabled) return;
    const [nx, ny] = pointAt(e);
    if (tool === "eraser") {
      if (e.buttons === 1) eraseAt(nx, ny);
      return;
    }
    const stroke = drawing.current;
    if (!stroke) return;
    stroke.points.push(nx, ny);
    const canvas = canvasRef.current;
    if (canvas) drawStrokes(canvas, [...value, stroke]);
  };

  const onPointerUp = () => {
    const stroke = drawing.current;
    drawing.current = null;
    if (stroke) onChange([...value, stroke]);
  };

  const undo = () => {
    if (!value.length) return;
    setRedo((r) => [...r, value[value.length - 1]]);
    onChange(value.slice(0, -1));
  };
  const redoLast = () => {
    if (!redo.length) return;
    const last = redo[redo.length - 1];
    setRedo((r) => r.slice(0, -1));
    onChange([...value, last]);
  };
  const clear = () => {
    if (value.length) setRedo([]);
    onChange([]);
  };

  const toolBtn =
    "flex h-8 w-8 items-center justify-center rounded-[7px] border text-body transition-colors";

  return (
    <div className="flex gap-3">
      {/* toolbar */}
      <div className="flex flex-col gap-[6px]">
        <button
          type="button"
          onClick={() => setTool("pencil")}
          disabled={disabled}
          aria-pressed={tool === "pencil"}
          title="Pencil"
          className={cn(toolBtn, tool === "pencil" ? "border-action bg-action-tint text-action" : "border-line-btn bg-card hover:border-line-hover")}
        >
          <Pencil size={15} />
        </button>
        <button
          type="button"
          onClick={() => setTool("eraser")}
          disabled={disabled}
          aria-pressed={tool === "eraser"}
          title="Eraser"
          className={cn(toolBtn, tool === "eraser" ? "border-action bg-action-tint text-action" : "border-line-btn bg-card hover:border-line-hover")}
        >
          <Eraser size={15} />
        </button>
        <div className="my-1 h-px bg-hairline" />
        {SIZES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSize(s.width)}
            disabled={disabled}
            aria-pressed={size === s.width}
            title={`${s.id === "s" ? "Small" : s.id === "m" ? "Medium" : "Large"} brush`}
            className={cn(toolBtn, size === s.width ? "border-action bg-sunken" : "border-line-btn bg-card hover:border-line-hover")}
          >
            <span className="rounded-full bg-body" style={{ width: s.dot, height: s.dot }} />
          </button>
        ))}
        <div className="my-1 h-px bg-hairline" />
        {COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setColor(c.value)}
            disabled={disabled}
            aria-pressed={color === c.value}
            title={c.label}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-[7px] border",
              color === c.value ? "border-action" : "border-line-btn",
            )}
          >
            <span className="h-4 w-4 rounded-full" style={{ background: c.value }} />
          </button>
        ))}
        <div className="my-1 h-px bg-hairline" />
        <button type="button" onClick={undo} disabled={disabled || !value.length} title="Undo" className={cn(toolBtn, "border-line-btn bg-card hover:border-line-hover disabled:opacity-40")}>
          <Undo2 size={15} />
        </button>
        <button type="button" onClick={redoLast} disabled={disabled || !redo.length} title="Redo" className={cn(toolBtn, "border-line-btn bg-card hover:border-line-hover disabled:opacity-40")}>
          <Redo2 size={15} />
        </button>
        <button type="button" onClick={clear} disabled={disabled || !value.length} title="Clear" className={cn(toolBtn, "border-line-btn bg-card text-critical hover:border-critical disabled:opacity-40")}>
          <Trash2 size={15} />
        </button>
      </div>

      {/* drawing surface */}
      <div
        ref={surfaceRef}
        className="relative h-[360px] flex-1 overflow-hidden rounded-[10px] border border-line bg-card"
      >
        <div className="absolute inset-0">
          <BodyFigures poses={poses} />
        </div>
        <canvas
          ref={canvasRef}
          className={cn("absolute inset-0 h-full w-full touch-none", disabled ? "cursor-default" : tool === "eraser" ? "cursor-cell" : "cursor-crosshair")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />
      </div>
    </div>
  );
}
