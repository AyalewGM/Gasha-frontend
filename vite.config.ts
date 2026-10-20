import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { apiBasePath } from "./src/apiRouting";

/** Explicitly load Vite's mode-specific environment for both browser and proxy. */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPrefix = apiBasePath(env.VITE_API_BASE_PATH);
  const backendTarget = env.GASHA_LOCAL_API_TARGET || "http://127.0.0.1:8000";
  const target = new URL(backendTarget);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== "/") {
    throw new Error("GASHA_LOCAL_API_TARGET must be a credential-free HTTP(S) backend origin");
  }
  const proxy = {
    [apiPrefix]: {
      target: target.origin,
      changeOrigin: false,
      rewrite: (path: string) =>
        path === apiPrefix ? "/" : path.startsWith(apiPrefix + "/") ? path.slice(apiPrefix.length) : path,
    },
  };
  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
  };
});
