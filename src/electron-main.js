import { app, BrowserWindow, powerSaveBlocker } from "electron";
import os from "node:os";
import path from "node:path";

const CHZZK_HOME = "https://chzzk.naver.com";
const NAVER_LOGIN_URL = "https://nid.naver.com/nidlogin.login";
const LIVE_STATUS_PATH_RE = /^\/polling\/v[\d.]+\/channels\/([^/]+)\/live-status$/;
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), ".stream-radio", "electron-profile");

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();

const cli = parseArgs(rawArgs);
const [command, target] = cli.positionals;

if (cli.flags.has("help") || !command) {
  printUsage();
  process.exit(0);
}

if (!["login", "play"].includes(command)) {
  console.error(`[stream-radio] Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

if (command === "play" && !target) {
  console.error("[stream-radio] Missing channelId or URL.");
  printUsage();
  process.exit(1);
}

const visible = command === "login" || cli.flags.has("visible");
const debug = cli.flags.has("debug");
const profileDir = path.resolve(cli.options.profile ?? DEFAULT_PROFILE_DIR);
const loginRedirectUrl = command === "login" ? toChzzkUrl(target ?? CHZZK_HOME) : undefined;
const url = command === "login"
  ? toNaverLoginUrl(loginRedirectUrl)
  : toChzzkUrl(target);

app.setName("stream-radio");
app.setPath("userData", profileDir);

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-features", "Vulkan");
}

let win;
let blockerId;
let shuttingDown = false;

void start();

async function start() {
  // Do not top-level-await app.whenReady() in Electron ESM.
  // Electron emits ready after the main module finishes evaluation.
  await app.whenReady();

  if (!visible && process.platform === "darwin") {
    app.dock.hide();
  }

  blockerId = powerSaveBlocker.start("prevent-app-suspension");

  win = new BrowserWindow({
    show: visible,
    width: 1280,
    height: 720,
    title: "stream-radio",
    skipTaskbar: !visible,
    backgroundColor: "#000000",
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Some services behave better when Electron's token is removed from UA.
  win.webContents.setUserAgent(
    win.webContents.getUserAgent().replace(/ Electron\/[\d.]+/g, ""),
  );

  win.webContents.setWindowOpenHandler(() => {
    if (!visible) {
      return { action: "deny" };
    }

    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        show: true,
        width: 1280,
        height: 720,
        webPreferences: {
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    };
  });

  win.on("closed", () => {
    shutdown(0);
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[stream-radio] Load failed (${errorCode}): ${errorDescription}`);
    if (debug) console.error(`[stream-radio] URL: ${validatedURL}`);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[stream-radio] Renderer process gone: ${details.reason}`);
    shutdown(1);
  });

  if (debug) {
    console.log(`[stream-radio] profile: ${profileDir}`);
    console.log(`[stream-radio] url: ${url}`);
    if (loginRedirectUrl) console.log(`[stream-radio] redirect: ${loginRedirectUrl}`);
    console.log(`[stream-radio] visible: ${visible}`);
  }

  if (debug) {
    attachDebugNavigationLogger(win);
  }

  if (command === "login") {
    attachLoginRedirectDetector(win, cli.flags.has("stay-open"));
    if (debug) await logCookieSummary(win, "before-login");
  }

  if (cli.flags.has("devtools")) {
    win.webContents.openDevTools({ mode: "detach" });
  }

  if (command === "login") {
    console.log("[stream-radio] Opening Naver login window...");
    console.log(`[stream-radio] Login URL: ${url}`);
    console.log(`[stream-radio] Redirect URL: ${loginRedirectUrl}`);
    console.log(`[stream-radio] Session profile: ${profileDir}`);
    console.log("[stream-radio] This command exits automatically after CHZZK redirect is detected.");
    console.log("[stream-radio] Use --stay-open to keep the login window open.");
  } else {
    console.log(`[stream-radio] Loading: ${url}`);
    console.log("[stream-radio] Waiting for live status before playback...");
    console.log("[stream-radio] Press Ctrl+C to stop.");

    win.webContents.setAudioMuted(true);

    let playbackStarted = false;
    const startPlayback = (reason) => {
      if (playbackStarted || win?.isDestroyed()) return;
      playbackStarted = true;

      if (debug) console.log(`[stream-radio] start playback via ${reason}`);
      win.webContents.setAudioMuted(false);
      schedulePlaybackPokes(win, debug);

      console.log("[stream-radio] Playing.");
    };

    const scannerAttached = attachLiveStatusScanner(win, debug, (content) => {
      if (content.status === "CLOSE") return;
      startPlayback(`live-status:${content.status || "UNKNOWN"}`);
    });

    if (!scannerAttached) {
      console.log("[stream-radio] Live-status scanner unavailable. Starting playback after page is ready.");
      win.webContents.once("dom-ready", () => startPlayback("dom-ready-fallback"));
    }
  }

  win.loadURL(url).catch((error) => {
    console.error(`[stream-radio] Failed to load page: ${error.message}`);
    shutdown(1);
  });

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

function parseArgs(argv) {
  const flags = new Set();
  const options = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg === "-h" || arg === "--help") {
      flags.add("help");
      continue;
    }

    if (arg === "--visible") {
      flags.add("visible");
      continue;
    }

    if (arg === "--debug") {
      flags.add("debug");
      continue;
    }

    if (arg === "--devtools") {
      flags.add("devtools");
      continue;
    }

    if (arg === "--stay-open") {
      flags.add("stay-open");
      continue;
    }

    if (arg === "--profile") {
      const value = argv[i + 1];
      if (!value) {
        console.error("[stream-radio] --profile requires a directory path.");
        process.exit(1);
      }
      options.profile = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--profile=")) {
      options.profile = arg.slice("--profile=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      console.error(`[stream-radio] Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }

    positionals.push(arg);
  }

  return { flags, options, positionals };
}

function printUsage() {
  console.log(`Usage:
  stream-radio login [channelId|url] [--profile <dir>]
  stream-radio play <channelId|url> [--visible] [--profile <dir>]

Options:
  --visible      Show the browser window while playing
  --profile DIR  Use a custom Electron profile directory
  --debug        Print debug logs
  --devtools     Open Electron DevTools
  --stay-open    Do not auto-close after login redirect
  -h, --help     Show this help
`);
}

function toChzzkUrl(input) {
  if (/^https?:\/\//i.test(input)) {
    return input;
  }

  return `${CHZZK_HOME}/live/${encodeURIComponent(input)}`;
}

function toNaverLoginUrl(redirectUrl) {
  const loginUrl = new URL(NAVER_LOGIN_URL);
  loginUrl.searchParams.set("url", redirectUrl);
  return loginUrl.toString();
}

function attachDebugNavigationLogger(targetWindow) {
  const log = (eventName, currentUrl) => {
    console.log(`[stream-radio] nav ${eventName}: ${currentUrl}`);
  };

  targetWindow.webContents.on("did-start-navigation", (_event, currentUrl, _isInPlace, isMainFrame) => {
    if (isMainFrame) log("did-start-navigation", currentUrl);
  });

  targetWindow.webContents.on("will-navigate", (_event, currentUrl) => {
    log("will-navigate", currentUrl);
  });

  targetWindow.webContents.on("did-redirect-navigation", (_event, currentUrl, _isInPlace, isMainFrame) => {
    if (isMainFrame) log("did-redirect-navigation", currentUrl);
  });

  targetWindow.webContents.on("did-navigate", (_event, currentUrl) => {
    log("did-navigate", currentUrl);
  });

  targetWindow.webContents.on("did-navigate-in-page", (_event, currentUrl, isMainFrame) => {
    if (isMainFrame) log("did-navigate-in-page", currentUrl);
  });
}

function attachLoginRedirectDetector(targetWindow, stayOpen) {
  let visitedNaverLogin = false;
  let detected = false;

  targetWindow.webContents.session.cookies.on("changed", (_event, cookie, cause, removed) => {
    if (!debug || !cookie.domain.includes("naver.com")) return;

    const action = removed ? "removed" : "set";
    console.log(
      `[stream-radio] cookie ${action}: ${cookie.domain}${cookie.path} ${cookie.name} ` +
      `httpOnly=${cookie.httpOnly} secure=${cookie.secure} cause=${cause}`,
    );
  });

  const handleUrl = async (currentUrl, source) => {
    if (detected) return;

    if (isNaverLoginUrl(currentUrl)) {
      visitedNaverLogin = true;
    }

    if (!visitedNaverLogin || !isChzzkUrl(currentUrl)) {
      return;
    }

    detected = true;
    console.log(`[stream-radio] Login redirect detected via ${source}: ${currentUrl}`);
    await logCookieSummary(targetWindow, "after-login-redirect");

    if (stayOpen) {
      console.log("[stream-radio] --stay-open is set. Press Ctrl+C when done.");
      return;
    }

    console.log("[stream-radio] Closing login window in 2 seconds...");
    setTimeout(() => shutdown(0), 2000);
  };

  targetWindow.webContents.on("did-start-navigation", (_event, currentUrl, _isInPlace, isMainFrame) => {
    if (isMainFrame) void handleUrl(currentUrl, "did-start-navigation");
  });

  targetWindow.webContents.on("did-redirect-navigation", (_event, currentUrl, _isInPlace, isMainFrame) => {
    if (isMainFrame) void handleUrl(currentUrl, "did-redirect-navigation");
  });

  targetWindow.webContents.on("did-navigate", (_event, currentUrl) => {
    void handleUrl(currentUrl, "did-navigate");
  });

  targetWindow.webContents.on("did-navigate-in-page", (_event, currentUrl, isMainFrame) => {
    if (isMainFrame) void handleUrl(currentUrl, "did-navigate-in-page");
  });
}

function isNaverLoginUrl(currentUrl) {
  try {
    return new URL(currentUrl).hostname === "nid.naver.com";
  } catch {
    return false;
  }
}

function isChzzkUrl(currentUrl) {
  try {
    return new URL(currentUrl).hostname === "chzzk.naver.com";
  } catch {
    return false;
  }
}

function attachLiveStatusScanner(targetWindow, shouldDebug, onLiveStatus) {
  const debuggerClient = targetWindow.webContents.debugger;
  const liveStatusRequests = new Map();
  let lastPrintedKey;
  let closeDetected = false;

  try {
    if (!debuggerClient.isAttached()) {
      debuggerClient.attach("1.3");
    }
  } catch (error) {
    if (shouldDebug) {
      console.error(`[stream-radio] live-status scanner attach failed: ${error.message}`);
    }
    return false;
  }

  debuggerClient.sendCommand("Network.enable").catch((error) => {
    if (shouldDebug) {
      console.error(`[stream-radio] Network.enable failed: ${error.message}`);
    }
  });

  if (shouldDebug) {
    console.log("[stream-radio] live-status scanner attached");
  }

  debuggerClient.on("message", (_event, method, params) => {
    if (method === "Network.responseReceived") {
      const requestId = params?.requestId;
      const responseUrl = params?.response?.url;
      const channelId = getLiveStatusChannelId(responseUrl);

      if (!requestId || !channelId) return;

      liveStatusRequests.set(requestId, { url: responseUrl, channelId });
      if (shouldDebug) console.log(`[stream-radio] live-status response: ${responseUrl}`);
      return;
    }

    if (method === "Network.loadingFinished") {
      const request = liveStatusRequests.get(params?.requestId);
      if (!request) return;

      liveStatusRequests.delete(params.requestId);
      void readLiveStatusBody(debuggerClient, params.requestId, request, shouldDebug, (content) => {
        const printed = printLiveStatus(content, request.channelId, lastPrintedKey);
        if (printed) lastPrintedKey = printed;

        if (!closeDetected && content.status === "CLOSE") {
          closeDetected = true;
          console.log("[stream-radio] Live is closed. Exiting.");
          setTimeout(() => shutdown(0), 1000);
          return;
        }

        onLiveStatus?.(content);
      });
      return;
    }

    if (method === "Network.loadingFailed") {
      liveStatusRequests.delete(params?.requestId);
    }
  });

  return true;
}

async function readLiveStatusBody(debuggerClient, requestId, request, shouldDebug, onContent) {
  try {
    const response = await debuggerClient.sendCommand("Network.getResponseBody", { requestId });
    const body = response.base64Encoded
      ? Buffer.from(response.body, "base64").toString("utf8")
      : response.body;
    const data = JSON.parse(body);

    if (data?.content) {
      onContent(data.content);
    } else if (shouldDebug) {
      console.log(`[stream-radio] live-status has no content: ${request.url}`);
    }
  } catch (error) {
    if (shouldDebug) {
      console.error(`[stream-radio] live-status parse failed: ${error.message}`);
    }
  }
}

function getLiveStatusChannelId(currentUrl) {
  if (!currentUrl) return undefined;

  try {
    const parsed = new URL(currentUrl);
    if (parsed.hostname !== "api.chzzk.naver.com") return undefined;

    const match = parsed.pathname.match(LIVE_STATUS_PATH_RE);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function printLiveStatus(content, channelId, lastPrintedKey) {
  const title = typeof content.liveTitle === "string" ? content.liveTitle.trim() : "";
  const status = typeof content.status === "string" ? content.status : "";
  const category = typeof content.liveCategoryValue === "string" ? content.liveCategoryValue : "";
  const viewers = Number.isFinite(content.concurrentUserCount)
    ? `${content.concurrentUserCount.toLocaleString("ko-KR")}명`
    : "";

  if (!title && !status) return undefined;

  const key = `${channelId}|${status}|${title}|${category}`;
  if (key === lastPrintedKey) return undefined;

  const details = [status, category, viewers].filter(Boolean).join(" · ");
  console.log(`[stream-radio] Live: ${title || "(no title)"}${details ? ` (${details})` : ""}`);

  return key;
}

async function logCookieSummary(targetWindow, label) {
  const cookieUrls = [
    "https://nid.naver.com",
    "https://www.naver.com",
    "https://chzzk.naver.com",
  ];

  const cookieMap = new Map();

  for (const cookieUrl of cookieUrls) {
    const cookies = await targetWindow.webContents.session.cookies.get({ url: cookieUrl });

    for (const cookie of cookies) {
      if (!cookie.domain.includes("naver.com")) continue;
      cookieMap.set(`${cookie.domain}\t${cookie.path}\t${cookie.name}`, cookie);
    }
  }

  const cookies = [...cookieMap.values()].sort((a, b) => {
    const left = `${a.domain}${a.path}${a.name}`;
    const right = `${b.domain}${b.path}${b.name}`;
    return left.localeCompare(right);
  });

  console.log(`[stream-radio] Cookie summary (${label}): ${cookies.length} naver/chzzk cookies`);

  for (const cookie of cookies) {
    const expires = cookie.expirationDate
      ? new Date(cookie.expirationDate * 1000).toISOString()
      : "session";

    console.log(
      `  - ${cookie.domain}${cookie.path} ${cookie.name} ` +
      `httpOnly=${cookie.httpOnly} secure=${cookie.secure} expires=${expires}`,
    );
  }
}

function schedulePlaybackPokes(targetWindow, shouldDebug) {
  for (const delay of [1500, 4000, 8000]) {
    setTimeout(() => {
      void pokePlayback(targetWindow, shouldDebug, delay);
    }, delay);
  }
}

async function pokePlayback(targetWindow, shouldDebug, delay) {
  if (targetWindow.isDestroyed()) return;

  const webContents = targetWindow.webContents;

  try {
    webContents.setAudioMuted(false);
    webContents.focus();

    const result = await webContents.executeJavaScript(`
      (() => {
        const videos = Array.from(document.querySelectorAll("video"));
        for (const video of videos) {
          video.muted = false;
          video.volume = 1;
          const promise = video.play?.();
          if (promise?.catch) promise.catch(() => {});
        }

        const candidates = Array.from(document.querySelectorAll("button, [role='button']"));
        const playButton = candidates.find((el) => {
          const text = [
            el.textContent,
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.getAttribute("class"),
          ].filter(Boolean).join(" ");
          return /재생|play/i.test(text);
        });
        playButton?.click?.();

        return {
          title: document.title,
          videoCount: videos.length,
          states: videos.map((video) => ({
            paused: video.paused,
            muted: video.muted,
            volume: video.volume,
            readyState: video.readyState,
          })),
        };
      })();
    `, true);

    sendCenterClick(webContents);
    sendSpace(webContents);

    if (shouldDebug) {
      console.log(`[stream-radio] playback poke after ${delay}ms: ${JSON.stringify(result)}`);
    }
  } catch (error) {
    if (shouldDebug) {
      console.error(`[stream-radio] playback poke failed after ${delay}ms: ${error.message}`);
    }
  }
}

function sendCenterClick(webContents) {
  const x = 640;
  const y = 360;

  webContents.sendInputEvent({ type: "mouseMove", x, y });
  webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

function sendSpace(webContents) {
  webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
  webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (blockerId && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
  }

  if (win && !win.isDestroyed()) {
    win.destroy();
  }

  app.quit();
  process.exit(exitCode);
}
