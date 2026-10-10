"use client";

/**
 * Zoom Meeting SDK (component view) loader.
 *
 * The SDK is loaded from Zoom's CDN at a pinned version, on the visit screen
 * only, and only after the server has returned a visit session — so no
 * third-party script runs anywhere else in the app, and nothing loads for a
 * visit that has no current consent authority. The route carries a
 * Content-Security-Policy that allows exactly these Zoom origins and nothing
 * else (`next.config.ts`).
 *
 * WHY THE VENDOR SCRIPTS. Zoom's embedded (component view) CDN build is not
 * self-contained: it binds to the `React`, `ReactDOM`, `Redux`, `ReduxThunk`
 * and `_` globals that Zoom documents loading alongside it, at the React 18
 * line the SDK was built against. This application is a React 19 bundle whose
 * React is module-scoped and never exposed on `window`, so the two do not
 * meet: Zoom's UI renders with Zoom's React inside the mount element, the app
 * renders with its own. The npm package pins React 18 as a peer dependency
 * and is not used for that reason. Loading only the SDK script — the first
 * attempt at this — fails with "React is not defined" before any client
 * exists; the bootstrap test (`e2e/zoom-sdk-bootstrap.spec.ts`) proves the
 * real pinned build registers, creates a client and initializes.
 */

export const ZOOM_MEETING_SDK_VERSION = "6.5.0";
const CDN = `https://source.zoom.us/${ZOOM_MEETING_SDK_VERSION}`;

/** Load order matters: each vendor global must exist before the SDK script evaluates. */
export const ZOOM_SDK_SCRIPTS: readonly string[] = [
  `${CDN}/lib/vendor/react.min.js`,
  `${CDN}/lib/vendor/react-dom.min.js`,
  `${CDN}/lib/vendor/redux.min.js`,
  `${CDN}/lib/vendor/redux-thunk.min.js`,
  `${CDN}/lib/vendor/lodash.min.js`,
  `${CDN}/zoom-meeting-embedded-${ZOOM_MEETING_SDK_VERSION}.min.js`,
];

export interface ZoomEmbeddedClient {
  init(options: {
    zoomAppRoot: HTMLElement;
    language?: string;
    patchJsMedia?: boolean;
    leaveOnPageUnload?: boolean;
    customize?: Record<string, unknown>;
  }): Promise<void>;
  join(options: {
    signature: string;
    meetingNumber: string;
    password: string;
    userName: string;
    zak?: string;
  }): Promise<void>;
  on(event: string, handler: (payload: unknown) => void): void;
  off?(event: string, handler: (payload: unknown) => void): void;
  leaveMeeting?(): Promise<void>;
  endMeeting?(): Promise<void>;
  getCurrentUser?(): { userId: number; isHost?: boolean } | null;
  getAttendeeslist?(): Array<{ userId: number; userName?: string; bHold?: boolean; isInWaitingRoom?: boolean }>;
  admit?(userId: number): Promise<void>;
}

interface ZoomEmbeddedNamespace {
  createClient(): ZoomEmbeddedClient;
}

declare global {
  interface Window {
    ZoomMtgEmbedded?: ZoomEmbeddedNamespace;
  }
}

export class ZoomSdkLoadError extends Error {
  constructor(readonly script: string, reason: "network" | "registration") {
    super(
      reason === "network"
        ? "The Zoom Meeting SDK could not be loaded."
        : "The Zoom Meeting SDK loaded but did not register.",
    );
    this.name = "ZoomSdkLoadError";
  }
}

let loading: Promise<ZoomEmbeddedNamespace> | null = null;

function invalidateLoadedScripts(): void {
  for (const src of ZOOM_SDK_SCRIPTS) {
    document.querySelectorAll<HTMLScriptElement>(`script[src="${src}"]`).forEach((element) => element.remove());
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }
    existing?.remove();
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => {
      script.remove();
      reject(new ZoomSdkLoadError(src, "network"));
    };
    document.head.appendChild(script);
  });
}

/**
 * Resolves the SDK namespace. A failed attempt (network or a script that
 * loaded without registering) clears the cached promise, so Retry really
 * retries instead of replaying the first failure until the page reloads.
 */
export function loadZoomMeetingSdk(): Promise<ZoomEmbeddedNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("Zoom SDK loads in the browser only."));
  if (window.ZoomMtgEmbedded) return Promise.resolve(window.ZoomMtgEmbedded);
  if (loading) return loading;
  loading = (async () => {
    try {
      for (const src of ZOOM_SDK_SCRIPTS) await loadScript(src);
      if (!window.ZoomMtgEmbedded) throw new ZoomSdkLoadError(ZOOM_SDK_SCRIPTS[ZOOM_SDK_SCRIPTS.length - 1], "registration");
      return window.ZoomMtgEmbedded;
    } catch (error) {
      // A failed bootstrap invalidates every element it added: a retry must
      // fetch and evaluate the scripts again, not skip "loaded" tags and
      // rediscover the same missing namespace.
      invalidateLoadedScripts();
      loading = null;
      throw error;
    }
  })();
  return loading;
}
