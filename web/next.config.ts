import type { NextConfig } from "next";

const config: NextConfig = {
  // Local tool: never expose the framework banner, and keep builds deterministic.
  poweredByHeader: false,
  // Pin the root: a stray lockfile in a parent directory would otherwise confuse detection.
  turbopack: { root: import.meta.dirname },
};

export default config;
