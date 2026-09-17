import { afterEach, describe, expect, it, vi } from "vitest";
import { createCaptureAudioBridge } from "./capture-audio-bridge";

function media() {
  const track = Object.assign(new EventTarget(), { readyState: "live", stop: vi.fn(() => { track.readyState = "ended"; }) });
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}
function audio() {
  const destination = { stream: media().stream };
  const sources: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const context = {
    state: "running",
    createMediaStreamDestination: vi.fn(() => destination),
    createMediaStreamSource: vi.fn(() => { const node = { connect: vi.fn(), disconnect: vi.fn() }; sources.push(node); return node; }),
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  return { destination, sources, context, bridge: (lost = vi.fn()) => createCaptureAudioBridge(lost, context as unknown as AudioContext) };
}
afterEach(() => vi.useRealTimers());
describe("stable capture audio stream", () => {
  it("replaces microphone input without replacing the recorder stream or connecting speakers", async () => {
    const a = audio(), first = media(), second = media(), bridge = a.bridge();
    bridge.replaceMicrophone(first.stream);
    await bridge.activate(new AbortController().signal);
    const output = bridge.stream;
    bridge.replaceMicrophone(second.stream);
    expect(bridge.stream).toBe(output); expect(bridge.hasMicrophone()).toBe(true);
    expect(first.track.stop).toHaveBeenCalledOnce();
    expect(a.sources[0]?.disconnect).toHaveBeenCalledOnce();
    expect(a.sources[1]?.connect).toHaveBeenCalledWith(a.destination);
    expect(a.context.createMediaStreamDestination).toHaveBeenCalledOnce();
    bridge.close(); expect(second.track.stop).toHaveBeenCalledOnce();
  });
  it("disconnects lost input, retains the output track, and can replace it explicitly", () => {
    const a = audio(), lost = vi.fn(), first = media(), second = media(), bridge = a.bridge(lost);
    bridge.replaceMicrophone(first.stream);
    first.track.dispatchEvent(new Event("ended"));
    expect(lost).toHaveBeenCalledOnce(); expect(bridge.hasMicrophone()).toBe(false);
    expect(bridge.stream.getAudioTracks()[0].readyState).toBe("live");
    bridge.replaceMicrophone(second.stream);
    first.track.dispatchEvent(new Event("ended"));
    expect(lost).toHaveBeenCalledOnce(); expect(bridge.hasMicrophone()).toBe(true);
    bridge.close(); expect(bridge.stream.getAudioTracks()[0].readyState).toBe("ended");
  });
  it("closes all resources once without reporting deliberate shutdown as device loss", () => {
    const a = audio(), lost = vi.fn(), first = media(), bridge = a.bridge(lost);
    bridge.replaceMicrophone(first.stream); bridge.close(); bridge.close();
    first.track.dispatchEvent(new Event("ended"));
    expect(lost).not.toHaveBeenCalled(); expect(a.context.close).toHaveBeenCalledOnce();
    const late = media(); expect(() => bridge.replaceMicrophone(late.stream)).toThrow();
    expect(late.track.stop).toHaveBeenCalledOnce();
  });
  it("refuses ended input rather than reporting a live microphone", () => {
    const a = audio(), first = media(), bridge = a.bridge(); first.track.stop();
    expect(() => bridge.replaceMicrophone(first.stream)).toThrow("microphone_unavailable");
    expect(bridge.hasMicrophone()).toBe(false); bridge.close();
  });
  it("bounds suspended audio-context activation and permits explicit cleanup", async () => {
    vi.useFakeTimers(); const a = audio(), first = media(), bridge = a.bridge();
    a.context.resume.mockImplementation(() => new Promise(() => {}));
    bridge.replaceMicrophone(first.stream);
    const check = expect(bridge.activate(new AbortController().signal)).rejects.toThrow("audio_context_unavailable");
    await vi.advanceTimersByTimeAsync(4000); await check;
    bridge.close(); expect(first.track.stop).toHaveBeenCalledOnce();
  });
});
