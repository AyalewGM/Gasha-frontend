import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Development/preview only. Production must route the chosen /api prefix
// through the authenticated same-origin reverse proxy to Gasha backend.
const backendTarget = process.env.GASHA_LOCAL_API_TARGET ?? "http://127.0.0.1:8000";
const apiPrefix = process.env.VITE_API_BASE_PATH ?? "/api";
if (!/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(apiPrefix) || apiPrefix === "/") {
  throw new Error("VITE_API_BASE_PATH must be a same-origin path such as /api");
}
const proxy = {
  [apiPrefix]: {
    target: backendTarget,
    changeOrigin: false,
    rewrite: (path: string) => path.replace(new RegExp("^" + apiPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
});
