import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Container deployment: .next/standalone carries the traced server. The `qloo mcp` child process is
  // not traced (it is spawned, not imported), so the image installs the harness separately.
  output: "standalone",
  // Set at build time when served under a path (the self-hosted server exposes /undercard on port 80).
  basePath: process.env.UNDERCARD_BASE_PATH || undefined,
};

export default nextConfig;
