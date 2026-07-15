"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Accessible action feedback. Announcements are placed in a polite aria-live
 * region (so screen readers hear them) and shown as transient visual toasts.
 * Used by the review-to-action layer to confirm outcomes without stealing focus.
 */
interface Toast {
  id: number;
  message: string;
}

interface FeedbackValue {
  announce: (message: string) => void;
}

const FeedbackContext = createContext<FeedbackValue | null>(null);

let nextId = 1;

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const announce = useCallback((message: string) => {
    const id = nextId++;
    setToasts((t) => [...t, { id, message }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 5000);
  }, []);

  const value = useMemo(() => ({ announce }), [announce]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {/* Visual toasts */}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[200] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="animate-fade-up pointer-events-auto max-w-[520px] rounded-[10px] border border-line bg-ink px-[14px] py-[9px] text-[12.5px] font-medium text-white shadow-[0_8px_24px_rgba(24,42,61,0.28)]"
          >
            {t.message}
          </div>
        ))}
      </div>
      {/* Screen-reader announcement channel */}
      <div aria-live="polite" role="status" className="sr-only">
        {toasts.map((t) => (
          <p key={t.id}>{t.message}</p>
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackValue {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error("useFeedback must be used within FeedbackProvider");
  return ctx;
}
