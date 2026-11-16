import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ErrorBoundary } from "./components/app/ErrorBoundary";
import { logUncaughtErrors } from "./lib/errorLog";
import { blockStrayDrops } from "./lib/native";
import { queryClient } from "./lib/queryClient";
import { initTheme } from "./lib/theme";
import "./index.css";

logUncaughtErrors();
initTheme();
blockStrayDrops();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary where="app">
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>,
);
