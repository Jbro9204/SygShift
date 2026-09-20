import { describe, expect, it } from "vitest";
import { assessCommunicationsBrowserCapabilities } from "./sygsphereCommunicationsBrowserCapabilities";

describe("SygSphere communications browser capability assessment", () => {
  it("closes every sensitive capability outside a secure context", () => {
    const result = assessCommunicationsBrowserCapabilities({
      hasDisplayMedia: true,
      hasGetUserMedia: true,
      hasPeerConnection: true,
      hasWebSocket: true,
      secureContext: false,
    });
    expect(result.controlTransport.available).toBe(false);
    expect(result.audioCapture.available).toBe(false);
    expect(result.cameraCapture.available).toBe(false);
    expect(result.screenCapture.available).toBe(false);
  });

  it("keeps screen capture unavailable when a mobile browser exposes calls but not display capture", () => {
    const result = assessCommunicationsBrowserCapabilities({
      hasDisplayMedia: false,
      hasGetUserMedia: true,
      hasPeerConnection: true,
      hasWebSocket: true,
      secureContext: true,
    });
    expect(result.audioCapture.available).toBe(true);
    expect(result.webRtcMedia.available).toBe(true);
    expect(result.screenCapture.available).toBe(false);
    expect(result.screenCapture.detail).toContain("can view shared screens");
  });

  it("describes APIs as available without claiming that permission or a device exists", () => {
    const result = assessCommunicationsBrowserCapabilities({
      hasDisplayMedia: true,
      hasGetUserMedia: true,
      hasPeerConnection: true,
      hasWebSocket: true,
      secureContext: true,
    });
    expect(result.cameraCapture.available).toBe(true);
    expect(result.cameraCapture.detail).toContain("still required");
    expect(result.foregroundOnly).toBe(true);
  });
});
