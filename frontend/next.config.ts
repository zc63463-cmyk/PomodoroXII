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
        // 127.0.0.1 (not localhost) avoids IPv6 ::1 resolution mismatch when
        // uvicorn binds IPv4 only.
        destination: `${process.env.TASK_SPACE_API_TARGET ?? "http://127.0.0.1:8000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
