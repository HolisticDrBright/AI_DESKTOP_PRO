import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("hosted Desktop runtime image", () => {
  const dockerfile = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8");
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM "));

  it("uses a nonroot distroless Node runtime", () => {
    expect(runtimeStage).toContain("gcr.io/distroless/nodejs22-debian12:nonroot AS runtime");
    expect(runtimeStage).toContain('CMD ["server.js"]');
  });

  it("does not add a shell or operating-system package manager to the runtime", () => {
    expect(runtimeStage).not.toMatch(/\b(?:apt|apt-get|apk|yum|dnf)\b/);
    expect(runtimeStage).not.toContain('CMD ["sh"');
    expect(runtimeStage).not.toMatch(/^RUN /m);
  });
});
