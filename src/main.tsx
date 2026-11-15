import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

const root = createRoot(document.getElementById("root")!);

function mount(view: ReactNode) {
  root.render(<StrictMode>{view}</StrictMode>);
}

/**
 * Separate /analyst composition; NEVER import the synthetic App into the
 * protected route. This build-time installation gate defaults to OFF.
 * URL path is only navigation, never tenant/credential/capability authority.
 */
if (window.location.pathname === "/analyst") {
  if (import.meta.env.VITE_GASHA_ANALYST_PHASE_A === "true") {
    void import("./analyst/ProtectedAnalystEntry")
      .then(({ ProtectedAnalystEntry }) => mount(<ProtectedAnalystEntry />))
      .catch(() => mount(
        <main role="alert">Protected analyst workspace is unavailable.</main>,
      ));
  } else {
    mount(<main role="status">Protected analyst workspace is disabled.</main>);
  }
} else {
  // The existing demonstrator remains a separate synthetic-only route.
  void import("./App")
    .then(({ default: App }) => mount(<App />))
    .catch(() => mount(<main role="alert">Synthetic console unavailable.</main>));
}
