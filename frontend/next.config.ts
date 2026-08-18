import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    reactCompiler: true,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        // Overridable so local smoke gates can run an isolated backend on a
        // temporary port without touching an existing dev server on 8000.
        destination: `${process.env.TASK_SPACE_API_TARGET ?? "http://localhost:8000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
