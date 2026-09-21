import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Environment from the shell and from .env / .env.local files.
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const host = env.TAURI_DEV_HOST;

  // Optional: run the UI in a plain browser against a standalone `rclone rcd`
  // (no Tauri). See README, "Developing the UI in a browser".
  //   RCLONE_DEV_RC=http://127.0.0.1:5572 RCLONE_DEV_RC_AUTH=user:pass npm run dev
  const devRc = env.RCLONE_DEV_RC;
  const devRcAuth = env.RCLONE_DEV_RC_AUTH;

  return {
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    proxy: devRc
      ? {
          "/__rc": {
            target: devRc,
            changeOrigin: true,
            rewrite: (path: string) => path.replace(/^\/__rc/, ""),
            headers: devRcAuth
              ? { Authorization: "Basic " + Buffer.from(devRcAuth).toString("base64") }
              : {},
          },
        }
      : undefined,
  },
  };
});
