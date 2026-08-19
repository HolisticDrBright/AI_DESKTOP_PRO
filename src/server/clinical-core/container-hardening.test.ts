import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("hosted Desktop runtime image", () => {
  const dockerfile = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8");
  const appRunnerBootstrap = readFileSync(
    resolve(process.cwd(), "scripts/app-runner-server.mjs"),
    "utf8",
  );
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM "));

  it("uses a nonroot distroless Node runtime", () => {
    expect(runtimeStage).toContain("gcr.io/distroless/nodejs22-debian12:nonroot AS runtime");
    expect(runtimeStage).toContain('CMD ["app-runner-server.mjs"]');
    expect(appRunnerBootstrap).toContain('process.env.HOSTNAME = "0.0.0.0"');
    expect(appRunnerBootstrap).toContain('await import("./server.js")');
  });

  it("does not add a shell or operating-system package manager to the runtime", () => {
    expect(runtimeStage).not.toMatch(/\b(?:apt|apt-get|apk|yum|dnf)\b/);
    expect(runtimeStage).not.toContain('CMD ["sh"');
    expect(runtimeStage).not.toMatch(/^RUN /m);
  });
});
