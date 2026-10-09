"use client";

/**
 * Zoom Meeting SDK (component view) loader.
 *
 * The SDK is loaded from Zoom's CDN at a pinned version, on the visit screen
 * only, and only after the server has returned a visit session — so no
 * third-party script runs anywhere else in the app, and nothing loads for a
 * visit that has no signed consent. The route carries a Content-Security-
 * Policy that allows exactly these Zoom origins and nothing else
 * (`next.config.ts`).
 *
 * The npm package pins React 18 as a peer, which this app does not use; the
 * CDN build is self-contained and is the form Zoom documents for component
 * view in a plain page.
 */

export const ZOOM_MEETING_SDK_VERSION = "6.5.0";
const SDK_SCRIPT = `https://source.zoom.us/${ZOOM_MEETING_SDK_VERSION}/zoom-meeting-embedded-${ZOOM_MEETING_SDK_VERSION}.min.js`;

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

let loading: Promise<ZoomEmbeddedNamespace> | null = null;

export function loadZoomMeetingSdk(): Promise<ZoomEmbeddedNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("Zoom SDK loads in the browser only."));
  if (window.ZoomMtgEmbedded) return Promise.resolve(window.ZoomMtgEmbedded);
  if (loading) return loading;
  loading = new Promise<ZoomEmbeddedNamespace>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_SCRIPT;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      if (window.ZoomMtgEmbedded) resolve(window.ZoomMtgEmbedded);
      else reject(new Error("The Zoom Meeting SDK loaded but did not register."));
    };
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("The Zoom Meeting SDK could not be loaded."));
    };
    document.head.appendChild(script);
  });
  return loading;
}
