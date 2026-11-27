import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    // A megabyte approval-text test takes up to about 7s on the fork's 4-vCPU CI runners.
    testTimeout: 15_000,
    include: ["src/**/*.test.ts"],
    setupFiles: [
      "../shared/src/testing/longTempDir.ts",
      "../shared/src/testing/providerEnv.ts",
      "../shared/src/testing/gitEnv.ts",
    ],
  },
});
