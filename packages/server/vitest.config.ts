import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Fixed zone so timestamp assertions are deterministic (+08:00, like the spec examples).
    env: { TZ: "Asia/Manila" },
  },
});
