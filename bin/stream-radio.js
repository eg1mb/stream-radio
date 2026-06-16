#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const main = path.resolve(__dirname, "../src/electron-main.js");

const child = spawn(electron, [main, "--", ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`[stream-radio] Failed to start Electron: ${error.message}`);
  process.exit(1);
});

process.on("SIGINT", () => {
  child.kill("SIGINT");
  setTimeout(() => process.exit(130), 2000).unref();
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
  setTimeout(() => process.exit(143), 2000).unref();
});

child.on("exit", (code, signal) => {
  if (signal) {
    const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };
    process.exit(signalExitCodes[signal] ?? 1);
  }

  process.exit(code ?? 0);
});
