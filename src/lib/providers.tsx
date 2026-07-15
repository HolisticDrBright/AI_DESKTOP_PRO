"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/* ------------------------------------------------------------------ material */

export type Material = "solid" | "glass";

interface MaterialContextValue {
  material: Material;
  atmosphere: boolean;
  setMaterial: (m: Material) => void;
  setAtmosphere: (on: boolean) => void;
}

const MaterialContext = createContext<MaterialContextValue | null>(null);

const MATERIAL_KEY = "aidp:material";
const ATMOSPHERE_KEY = "aidp:atmosphere";

export function MaterialProvider({ children }: { children: ReactNode }) {
  // Surfaces support solid | glass; the design default is solid but the
  // user currently prefers glass, so glass is the shipped default.
  const [material, setMaterialState] = useState<Material>("glass");
  const [atmosphere, setAtmosphereState] = useState(true);

  useEffect(() => {
    const m = window.localStorage.getItem(MATERIAL_KEY);
    if (m === "solid" || m === "glass") setMaterialState(m);
    const a = window.localStorage.getItem(ATMOSPHERE_KEY);
    if (a === "on" || a === "off") setAtmosphereState(a === "on");
  }, []);

  const setMaterial = useCallback((m: Material) => {
    setMaterialState(m);
    window.localStorage.setItem(MATERIAL_KEY, m);
  }, []);

  const setAtmosphere = useCallback((on: boolean) => {
    setAtmosphereState(on);
    window.localStorage.setItem(ATMOSPHERE_KEY, on ? "on" : "off");
  }, []);

  const value = useMemo(
    () => ({ material, atmosphere, setMaterial, setAtmosphere }),
    [material, atmosphere, setMaterial, setAtmosphere],
  );

  return (
    <MaterialContext.Provider value={value}>{children}</MaterialContext.Provider>
  );
}

export function useMaterial(): MaterialContextValue {
  const ctx = useContext(MaterialContext);
  if (!ctx) throw new Error("useMaterial must be used within MaterialProvider");
  return ctx;
}

/* ------------------------------------------------------------------ shell ui */

interface ShellUiContextValue {
  cmdOpen: boolean;
  aiOpen: boolean;
  openCmd: () => void;
  closeCmd: () => void;
  toggleAi: () => void;
  closeAi: () => void;
  openAi: () => void;
}

const ShellUiContext = createContext<ShellUiContextValue | null>(null);

export function ShellUiProvider({ children }: { children: ReactNode }) {
  const [cmdOpen, setCmdOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key?.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((open) => !open);
      }
      if (e.key === "Escape") {
        setCmdOpen(false);
        setAiOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo<ShellUiContextValue>(
    () => ({
      cmdOpen,
      aiOpen,
      openCmd: () => setCmdOpen(true),
      closeCmd: () => setCmdOpen(false),
      toggleAi: () => setAiOpen((open) => !open),
      closeAi: () => setAiOpen(false),
      openAi: () => setAiOpen(true),
    }),
    [cmdOpen, aiOpen],
  );

  return (
    <ShellUiContext.Provider value={value}>{children}</ShellUiContext.Provider>
  );
}

export function useShellUi(): ShellUiContextValue {
  const ctx = useContext(ShellUiContext);
  if (!ctx) throw new Error("useShellUi must be used within ShellUiProvider");
  return ctx;
}
