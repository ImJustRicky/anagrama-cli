#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import open from "open";
import { select } from "@inquirer/prompts";
import boxen from "boxen";
import fs from "fs/promises";
import os from "os";
import path from "path";
import readline from "readline/promises";
import process from "process";
import crypto from "crypto";
import { execFile, spawn } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version: CURRENT_VERSION } = require("../package.json") as { version: string };

const DEFAULT_SITE_URL = process.env.ANAGRAMA_URL || "https://playanagrama.com";
const DEFAULT_API_URL = process.env.ANAGRAMA_API_URL || "https://api.playanagrama.com";
const CONFIG_DIR = path.join(os.homedir(), ".anagrama");
const CRED_PATH = path.join(CONFIG_DIR, "credentials");
const CONFIG_PATH = path.join(CONFIG_DIR, "cli.json");
const UPDATE_PATH = path.join(CONFIG_DIR, "update.json");
const STATS_PATH = path.join(CONFIG_DIR, "stats.json");
const NPM_REGISTRY_URL = "https://registry.npmjs.org/anagrama/latest";
const CHECK_INTERVAL_MS = 0; // Check every launch

// Encrypted credential storage (pure JS, no native deps)
// Derives a machine-specific key from hostname + homedir so the file isn't portable
function credKey(): Buffer {
  const seed = `anagrama:${os.hostname()}:${os.homedir()}`;
  return crypto.createHash("sha256").update(seed).digest();
}

async function getSecureToken(): Promise<string | null> {
  try {
    const raw = await fs.readFile(CRED_PATH, "utf8");
    const { iv, data } = JSON.parse(raw) as { iv: string; data: string };
    const decipher = crypto.createDecipheriv("aes-256-cbc", credKey(), Buffer.from(iv, "hex"));
    let decrypted = decipher.update(data, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted || null;
  } catch {
    return null;
  }
}

async function setSecureToken(token: string): Promise<boolean> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", credKey(), iv);
    let encrypted = cipher.update(token, "utf8", "hex");
    encrypted += cipher.final("hex");
    await fs.writeFile(CRED_PATH, JSON.stringify({ iv: iv.toString("hex"), data: encrypted }), { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

async function deleteSecureToken(): Promise<void> {
  try {
    await fs.unlink(CRED_PATH);
  } catch {
    // File doesn't exist or already deleted
  }
}

// Migrate plain-text tokens (from older versions) to encrypted storage
async function migrateCredentials(): Promise<void> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw) as StoredConfig;
    if (config.token) {
      // Token exists in plain text config — encrypt it
      await setSecureToken(config.token);
      const { token, ...rest } = config;
      await fs.writeFile(CONFIG_PATH, JSON.stringify(rest, null, 2), "utf8");
    }
  } catch {
    // No existing config or already migrated
  }
}

/** Clear screen + scrollback buffer so old renders don't show when scrolling up. */
function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

// Prevent Ctrl+C from killing the app - must use menu to exit
process.on("SIGINT", () => {
  console.log(chalk.gray("\n  Use the menu or /quit to exit."));
});

type StoredConfig = {
  baseUrl?: string;  // site URL (for browser links)
  apiUrl?: string;   // API URL (for backend calls)
  token?: string;
  user?: {
    userId?: string;
    username?: string | null;
    displayName?: string | null;
  };
  updatedAt?: string;
  minimal?: boolean;
  theme?: string;
};

// ── Theme system ─────────────────────────────────────────────────────────────

type ThemeColors = {
  accent: string;
  border: string;
  fg: string;
  dim: string;
  bg: string; // background color for boxes (empty = transparent/terminal default)
  tileFg: string; // letter tile text color (needs to contrast with accent bg)
  label: string;
  group: "dark" | "light" | "accessibility";
};

const THEMES: Record<string, ThemeColors> = {
  // Dark themes (no bg — use terminal background)
  amber:    { accent: "#F5A623", border: "#CC6B3D", fg: "#FFFFFF", dim: "#888888", bg: "", tileFg: "#1a1a1a", label: "Amber (Default)", group: "dark" },
  ocean:    { accent: "#4FC3F7", border: "#0288D1", fg: "#FFFFFF", dim: "#888888", bg: "", tileFg: "#1a1a1a", label: "Ocean", group: "dark" },
  forest:   { accent: "#66BB6A", border: "#388E3C", fg: "#FFFFFF", dim: "#888888", bg: "", tileFg: "#1a1a1a", label: "Forest", group: "dark" },
  sunset:   { accent: "#EF5350", border: "#C62828", fg: "#FFFFFF", dim: "#888888", bg: "", tileFg: "#1a1a1a", label: "Sunset", group: "dark" },
  lavender: { accent: "#CE93D8", border: "#8E24AA", fg: "#FFFFFF", dim: "#888888", bg: "", tileFg: "#1a1a1a", label: "Lavender", group: "dark" },
  mint:     { accent: "#4DB6AC", border: "#00897B", fg: "#FFFFFF", dim: "#888888", bg: "", tileFg: "#1a1a1a", label: "Mint", group: "dark" },
  // Light themes (bg highlight so dark text is readable on any terminal)
  "light":      { accent: "#D4760A", border: "#B8621A", fg: "#1a1a1a", dim: "#666666", bg: "#F5F5F0", tileFg: "#FFFFFF", label: "Light", group: "light" },
  "light-blue": { accent: "#0277BD", border: "#01579B", fg: "#1a1a1a", dim: "#666666", bg: "#EDF2F7", tileFg: "#FFFFFF", label: "Light Blue", group: "light" },
  // Accessibility - high contrast
  "hc-dark":  { accent: "#FFD600", border: "#FFAB00", fg: "#FFFFFF", dim: "#CCCCCC", bg: "",        tileFg: "#000000", label: "High Contrast Dark", group: "accessibility" },
  "hc-light": { accent: "#0D47A1", border: "#1565C0", fg: "#000000", dim: "#444444", bg: "#FFFFFF", tileFg: "#FFFFFF", label: "High Contrast Light", group: "accessibility" },
};

let currentThemeName = "amber";

function getTheme(): ThemeColors {
  return THEMES[currentThemeName] || THEMES.amber;
}

function applyTheme(name: string): void {
  if (THEMES[name]) {
    currentThemeName = name;
    const t = THEMES[name];
    accent = chalk.hex(t.accent);
    fg = chalk.hex(t.fg);
    dim = chalk.hex(t.dim);
  }
}

/** Wrap a line in the theme's background color if one is set (for light themes). */
function bgLine(text: string): string {
  const t = getTheme();
  if (!t.bg) return text;
  return chalk.bgHex(t.bg)(text);
}

/** Get boxen options for current theme (borderColor + optional backgroundColor). */
function boxenTheme(): { borderColor: string; backgroundColor?: string } {
  const t = getTheme();
  const opts: { borderColor: string; backgroundColor?: string } = { borderColor: t.border };
  if (t.bg) opts.backgroundColor = t.bg;
  return opts;
}

/** Detect system dark/light mode from env vars or macOS settings. */
async function detectSystemTheme(): Promise<"dark" | "light"> {
  // COLORFGBG is set by many terminals (iTerm2, xterm, etc.)
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bg = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(bg)) return bg > 8 ? "light" : "dark";
  }

  // macOS: check system appearance
  if (process.platform === "darwin") {
    try {
      return await new Promise((resolve) => {
        execFile("defaults", ["read", "-g", "AppleInterfaceStyle"], { timeout: 1000 }, (err, stdout) => {
          if (stdout?.trim().toLowerCase() === "dark") {
            resolve("dark");
          } else {
            resolve("light"); // No AppleInterfaceStyle = light mode
          }
        });
      });
    } catch {
      // Fall through
    }
  }

  // Windows: check registry for system theme (AppsUseLightTheme = 0 means dark)
  if (process.platform === "win32") {
    try {
      return await new Promise((resolve) => {
        execFile("reg", [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
          "/v", "AppsUseLightTheme",
        ], { shell: true, timeout: 1000 }, (err, stdout) => {
          if (err || !stdout) { resolve("dark"); return; }
          // Output contains "0x0" for dark, "0x1" for light
          resolve(stdout.includes("0x0") ? "dark" : "light");
        });
      });
    } catch {
      // Fall through
    }
  }

  return "dark"; // Default assumption
}

type ApiResponse<T> = { status: number; data: T };

// ── Stats tracking ───────────────────────────────────────────────────────────

type GameStats = {
  gamesPlayed: number;
  gamesWon: number;
  currentStreak: number;
  maxStreak: number;
  guessDistribution: number[]; // index 0 = solved in 1, index 4 = solved in 5
  lastPlayedDate: string;
  lastPlayedWon: boolean;
  lastPlayedAttempts: number;
};

const DEFAULT_STATS: GameStats = {
  gamesPlayed: 0,
  gamesWon: 0,
  currentStreak: 0,
  maxStreak: 0,
  guessDistribution: [0, 0, 0, 0, 0],
  lastPlayedDate: "",
  lastPlayedWon: false,
  lastPlayedAttempts: 0,
};

async function readStats(): Promise<GameStats> {
  try {
    const raw = await fs.readFile(STATS_PATH, "utf8");
    return { ...DEFAULT_STATS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATS };
  }
}

async function writeStats(stats: GameStats): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(STATS_PATH, JSON.stringify(stats, null, 2), "utf8");
}

async function updateStats(won: boolean, attempts: number, dateKey: string): Promise<GameStats> {
  const stats = await readStats();
  if (stats.lastPlayedDate === dateKey) return stats; // Already recorded
  stats.gamesPlayed++;
  stats.lastPlayedDate = dateKey;
  stats.lastPlayedWon = won;
  stats.lastPlayedAttempts = attempts;
  if (won) {
    stats.gamesWon++;
    stats.currentStreak++;
    stats.maxStreak = Math.max(stats.maxStreak, stats.currentStreak);
    const idx = Math.min(attempts - 1, 4);
    stats.guessDistribution[idx] = (stats.guessDistribution[idx] || 0) + 1;
  } else {
    stats.currentStreak = 0;
  }
  await writeStats(stats);
  return stats;
}

// ── Share results ────────────────────────────────────────────────────────────

function generateShareText(
  dateKey: string,
  guessHistory: { word: string; marks: string[] }[],
  won: boolean,
  maxLives: number,
): string {
  const attemptsText = won ? `${guessHistory.length}/${maxLives}` : `X/${maxLives}`;
  let text = `Anagrama ${dateKey} ${attemptsText}\n\n`;
  for (const g of guessHistory) {
    text += g.marks.map((m) => {
      if (m === "correct") return "\u{1F7E9}";
      if (m === "present") return "\u{1F7E8}";
      return "\u2B1B";
    }).join("") + "\n";
  }
  text += "\nplayanagrama.com";
  return text;
}

async function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let cmd: string;
    let args: string[] = [];
    if (process.platform === "darwin") {
      cmd = "pbcopy";
    } else if (process.platform === "win32") {
      cmd = "clip";
    } else {
      cmd = "xclip";
      args = ["-selection", "clipboard"];
    }
    try {
      const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      proc.stdin.write(text);
      proc.stdin.end();
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

function getNextPuzzleCountdown(): string {
  // Puzzle resets at midnight ET
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const tomorrow = new Date(et);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const diff = tomorrow.getTime() - et.getTime();
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

// ── End stats / share ────────────────────────────────────────────────────────

// Fun welcome messages related to anagrams
const WELCOME_MESSAGES = [
  (name: string) => `Welcome back, ${name}! Ready to unscramble some letters?`,
  (name: string) => `${name} has entered the game! Time to make words happen.`,
  (name: string) => `The letters tremble in fear... ${name} is here!`,
  (name: string) => `${name}! Your daily dose of word chaos awaits.`,
  (name: string) => `Ah, ${name}! The alphabet's favorite rearranager.`,
  (name: string) => `${name} logged in! Let's turn scrambled eggs into words.`,
  (name: string) => `Welcome, ${name}! May your anagrams be ever solvable.`,
  (name: string) => `${name}! Ready to give those letters a new identity?`,
];

function getRandomWelcome(name: string): string {
  const idx = Math.floor(Math.random() * WELCOME_MESSAGES.length);
  return WELCOME_MESSAGES[idx](name);
}

async function readConfig(): Promise<StoredConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw) as StoredConfig;
    // Get token from secure storage
    const token = await getSecureToken();
    return { ...config, token: token || undefined };
  } catch {
    // Even if config file doesn't exist, try to get token from keychain
    const token = await getSecureToken();
    return { token: token || undefined };
  }
}

async function writeConfig(next: StoredConfig): Promise<void> {
  // Store token securely in system keychain
  if (next.token) {
    await setSecureToken(next.token);
  }
  // Write non-sensitive data to JSON (without token)
  const { token, ...configWithoutToken } = next;
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(configWithoutToken, null, 2), "utf8");
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

// ── Auto-update ──────────────────────────────────────────────────────────────

type UpdateState = {
  lastCheck?: string;
  latestVersion?: string;
  installed?: boolean;
};

async function readUpdateState(): Promise<UpdateState> {
  try {
    const raw = await fs.readFile(UPDATE_PATH, "utf8");
    return JSON.parse(raw) as UpdateState;
  } catch {
    return {};
  }
}

async function writeUpdateState(state: UpdateState): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(UPDATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

/** Compare two semver strings (x.y.z). Returns true if a > b. */
function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

/** In-memory flags for update state during this session. */
let updateInstalledVersion: string | null = null;
let pendingUpdateVersion: string | null = null;
let updateFailed = false;

const UPDATE_QUIPS = [
  "Woah, new letters just dropped!",
  "Fresh scramble incoming!",
  "The letters have been reshuffled!",
  "New word magic unlocked!",
  "Plot twist: we got better!",
];

/**
 * Check npm registry for a newer version. Respects CHECK_INTERVAL_MS throttle.
 * Returns the latest version string if an update is available, null otherwise.
 */
async function checkForUpdate(): Promise<string | null> {
  try {
    const state = await readUpdateState();

    // If a previous install completed but user has since restarted, clear the flag
    if (state.installed && state.latestVersion && !semverGt(state.latestVersion, CURRENT_VERSION)) {
      await writeUpdateState({ ...state, installed: false });
    }

    // If we already installed an update this session or a previous one, skip
    if (state.installed && state.latestVersion && semverGt(state.latestVersion, CURRENT_VERSION)) {
      updateInstalledVersion = state.latestVersion;
      return null; // already installed, just needs restart
    }

    // Throttle: skip if checked recently
    if (state.lastCheck) {
      const elapsed = Date.now() - new Date(state.lastCheck).getTime();
      if (elapsed < CHECK_INTERVAL_MS) return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return null;

    await writeUpdateState({ lastCheck: new Date().toISOString(), latestVersion: latest, installed: false });

    return semverGt(latest, CURRENT_VERSION) ? latest : null;
  } catch {
    return null; // network error, offline, etc. - silently skip
  }
}

/**
 * Install the update in the background via npm. Sets updateInstalledVersion
 * when done so the UI can show a restart prompt.
 */
function installUpdateInBackground(version: string): void {
  pendingUpdateVersion = version;
  try {
    execFile("npm", ["install", "-g", `anagrama@${version}`], { shell: true, timeout: 60_000 }, async (err) => {
      if (!err) {
        updateInstalledVersion = version;
        pendingUpdateVersion = null;
        await writeUpdateState({
          lastCheck: new Date().toISOString(),
          latestVersion: version,
          installed: true,
        }).catch(() => {});
      } else {
        updateFailed = true; // Keep banner visible with manual install hint
      }
      // Trigger homescreen re-render
      process.stdout.emit("resize");
    });
  } catch {
    updateFailed = true;
  }
}

/** Manual update: check + install with progress feedback. Returns "installed" | "up-to-date" | "skipped" | "error". */
async function doManualUpdate(): Promise<"installed" | "up-to-date" | "skipped" | "error"> {
  const spinner = new ColorSpinner("Checking for updates...");
  spinner.start();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      spinner.stop(chalk.yellow("  Could not reach npm registry."));
      return "error";
    }

    const data = (await res.json()) as { version?: string };
    const latest = data.version;

    if (!latest || !semverGt(latest, CURRENT_VERSION)) {
      spinner.stop(chalk.green(`  You're on the latest version (v${CURRENT_VERSION}).`));
      return "up-to-date";
    }

    spinner.stop(chalk.cyan(`  Update available: v${CURRENT_VERSION} → v${latest}`));

    const confirm = await select({
      message: "Install update now?",
      choices: [
        { name: "Yes, install", value: true },
        { name: "Not now", value: false },
      ],
    });

    if (!confirm) return "skipped";

    const installSpinner = new ColorSpinner("Installing update...");
    installSpinner.start();

    return await new Promise<"installed" | "error">((resolve) => {
      execFile("npm", ["install", "-g", `anagrama@${latest}`], { shell: true, timeout: 60_000 }, (err) => {
        if (err) {
          installSpinner.stop(chalk.red(`  Update failed. Try manually: npm install -g anagrama@latest`));
          resolve("error");
        } else {
          installSpinner.stop(chalk.green(`  Updated to v${latest}! Restart to use it.`));
          resolve("installed");
        }
      });
    });
  } catch {
    spinner.stop(chalk.yellow("  Could not check for updates (offline?)."));
    return "error";
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** Interactive theme picker with live preview. Arrow keys browse, Enter confirms, Esc cancels. */
async function doThemePicker(): Promise<string | null> {
  const themeKeys = Object.keys(THEMES);
  let idx = themeKeys.indexOf(currentThemeName);
  if (idx === -1) idx = 0;
  const original = currentThemeName;

  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const render = () => {
      const key = themeKeys[idx];
      const theme = THEMES[key];
      const previewAccent = chalk.hex(theme.accent);
      const previewBorder = chalk.hex(theme.border);
      const previewFg = chalk.hex(theme.fg);
      const previewDim = chalk.hex(theme.dim);
      const previewBgWrap = (text: string) => theme.bg ? chalk.bgHex(theme.bg)(text) : text;

      clearScreen();
      console.log();
      console.log(previewBorder("  ──") + previewAccent.bold(" Choose Theme ") + previewBorder("─".repeat(30)));

      // Group themes by category
      let lastGroup = "";
      for (let i = 0; i < themeKeys.length; i++) {
        const k = themeKeys[i];
        const t = THEMES[k];
        // Show group header
        if (t.group !== lastGroup) {
          lastGroup = t.group;
          const groupLabel = t.group === "dark" ? "Dark" : t.group === "light" ? "Light" : "Accessibility";
          console.log();
          console.log(previewDim(`    ${groupLabel}`));
        }
        const dot = chalk.hex(t.accent)("●");
        if (i === idx) {
          // Apply bg highlight for light themes so dark text is visible on dark terminals
          const label = theme.bg
            ? chalk.bgHex(theme.bg).hex(theme.fg).bold(` ${t.label} `)
            : previewFg.bold(t.label);
          console.log(`  ${chalk.hex(t.accent)("▸")} ${dot} ${label}`);
        } else {
          console.log(`    ${dot} ${previewDim(t.label)}`);
        }
      }

      console.log();
      console.log(previewBgWrap(previewBorder("  ──") + previewAccent.bold(" Preview ") + previewBorder("─".repeat(35))));
      console.log();

      // Preview: title
      console.log(previewBgWrap(`  ${previewAccent.bold("◆ Anagrama")} ${previewDim(`v${CURRENT_VERSION}`)}  `));
      console.log();

      // Preview: sample letter tiles
      const tiles = ["A", "N", "A"].map(ch =>
        chalk.bgHex(theme.accent).hex(theme.tileFg).bold(` ${ch} `)
      ).join("  ");
      console.log(`    ${tiles}`);
      console.log();

      // Preview: lives
      console.log(previewBgWrap(`  ${previewAccent("●●●●")}${previewDim("○")}  ${previewDim("Lives")}  `));
      console.log();

      // Preview: sample box
      const sampleBox = boxen(previewFg("Find the target word"), {
        borderColor: theme.border,
        ...(theme.bg ? { backgroundColor: theme.bg } : {}),
        borderStyle: "round",
        padding: { left: 1, right: 1, top: 0, bottom: 0 },
      });
      for (const line of sampleBox.split("\n")) {
        console.log("  " + line);
      }
      console.log();

      console.log(previewBgWrap(previewDim("  ↑↓ Browse  Enter Confirm  Esc Cancel  ")));
    };

    render();

    const handleKey = (key: string) => {
      if (key === "\u001B[A") { // Up
        idx = idx <= 0 ? themeKeys.length - 1 : idx - 1;
        render();
        return;
      }
      if (key === "\u001B[B") { // Down
        idx = idx >= themeKeys.length - 1 ? 0 : idx + 1;
        render();
        return;
      }
      if (key === "\r" || key === "\n") { // Confirm
        stdin.setRawMode(false);
        stdin.removeListener("data", handleKey);
        resolve(themeKeys[idx]);
        return;
      }
      if (key === "\u001B" && key.length === 1) { // Cancel
        applyTheme(original);
        stdin.setRawMode(false);
        stdin.removeListener("data", handleKey);
        resolve(null);
        return;
      }
    };

    stdin.on("data", handleKey);
  });
}

async function doSettings(config: StoredConfig): Promise<void> {
  let inSettings = true;

  while (inSettings) {
    clearScreen();
    console.log();

    const themeName = currentThemeName;
    const themeLabel = THEMES[themeName]?.label || "Amber (Default)";
    const displayMode = config.minimal ? "Minimal" : "Full";

    const cardLines: string[] = [];
    cardLines.push(dim("Theme    ") + accent(themeLabel));
    cardLines.push(dim("Display  ") + fg(displayMode));
    cardLines.push(dim("Version  ") + fg(`v${CURRENT_VERSION}`));

    console.log(boxen(cardLines.join("\n"), {
      ...boxenTheme(),
      borderStyle: "round",
      title: accent.bold(" Settings "),
      titleAlignment: "left",
      padding: { left: 1, right: 1, top: 1, bottom: 1 },
      margin: { left: 2 },
    }));
    console.log();

    const action = await select({
      message: "Settings",
      choices: [
        { name: `Theme: ${themeLabel}`, value: "theme" },
        { name: `Display: ${displayMode}`, value: "display" },
        { name: "Check for updates", value: "update" },
        { name: "Back", value: "back" },
      ],
    });

    switch (action) {
      case "theme": {
        const picked = await doThemePicker();
        if (picked) {
          applyTheme(picked);
          config.theme = picked;
          await writeConfig(config);
        }
        break;
      }
      case "display": {
        config.minimal = !config.minimal;
        await writeConfig(config);
        break;
      }
      case "update": {
        const result = await doManualUpdate();
        if (result === "installed") {
          console.log();
          const next = await select({
            message: "What next?",
            choices: [
              { name: "Quit (restart to apply)", value: "quit" },
              { name: "Home", value: "home" },
            ],
          });
          if (next === "quit") {
            console.log(chalk.gray("  Goodbye!"));
            process.exit(0);
          }
          inSettings = false; // Go home
        } else {
          console.log();
          console.log(chalk.gray("  Press Enter to continue..."));
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          await rl.question("");
          rl.close();
        }
        break;
      }
      case "back":
        inSettings = false;
        break;
    }
  }
}

// ── End auto-update / settings ───────────────────────────────────────────────

async function apiPost<T>(baseUrl: string, pathUrl: string, body: unknown, token?: string): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${pathUrl}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

async function apiGet<T>(baseUrl: string, pathUrl: string, token?: string): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${pathUrl}`, {
    method: "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Colorful spinner frames
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_COLORS = [
  chalk.cyan,
  chalk.magenta,
  chalk.yellow,
  chalk.green,
  chalk.blue,
  chalk.red,
  chalk.white,
];

class ColorSpinner {
  private frameIndex = 0;
  private colorIndex = 0;
  private interval: NodeJS.Timeout | null = null;
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  start(): void {
    process.stdout.write("\x1B[?25l"); // Hide cursor
    this.render();
    this.interval = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      if (this.frameIndex === 0) {
        this.colorIndex = (this.colorIndex + 1) % SPINNER_COLORS.length;
      }
      this.render();
    }, 80);
  }

  private render(): void {
    const frame = SPINNER_FRAMES[this.frameIndex];
    const color = SPINNER_COLORS[this.colorIndex];
    process.stdout.write(`\r${color(frame)} ${this.message}`);
  }

  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    process.stdout.write("\r\x1B[K"); // Clear line
    process.stdout.write("\x1B[?25h"); // Show cursor
    if (finalMessage) {
      console.log(finalMessage);
    }
  }
}

function renderMarks(guess: string, marks: string[] | null | undefined): string {
  const chars = guess.toUpperCase().split("");
  return chars
    .map((ch, idx) => {
      const mark = marks?.[idx];
      if (mark === "correct") return chalk.black.bgGreen(` ${ch} `);
      if (mark === "present") return chalk.black.bgYellow(` ${ch} `);
      if (mark === "absent") return chalk.white.bgGray(` ${ch} `);
      return ` ${ch} `;
    })
    .join("");
}

// Get terminal width for responsive layout
function getTermWidth(): number {
  return process.stdout.columns || 80;
}

// Claude Code-style homescreen
function printHomescreen(config: StoredConfig, minimal = false): void {
  const termWidth = getTermWidth();
  const name = config.user?.displayName || config.user?.username || "Player";
  const isLoggedIn = !!config.token;

  // Auto-switch to compact mode for narrow terminals
  if (minimal || termWidth < 60) {
    console.log();
    console.log(bgLine(accent.bold(`  ◆ Anagrama`) + dim(` v${CURRENT_VERSION}`)));
    if (isLoggedIn) {
      console.log(bgLine(dim(`  Welcome back, `) + fg(name) + dim(`!`)));
    }
    console.log();
    return;
  }

  const welcomeMsg = isLoggedIn ? `Welcome back, ${name}!` : "Welcome to Anagrama!";
  const versionLine = `v${CURRENT_VERSION}  ·  ${config.baseUrl || DEFAULT_SITE_URL}`;

  const lines: string[] = [];
  lines.push(fg.bold(welcomeMsg));
  lines.push(dim(versionLine));
  lines.push("");

  if (termWidth >= 80) {
    const mascotArt = [
      "  ┌───┐ ┌───┐",
      "  │ A │ │ N │",
      "  └───┘ └───┘",
      "     ┌───┐",
      "     │ A │",
      "     └───┘",
    ];
    lines.push(...mascotArt.map(l => accent(l)));
    lines.push("");
  }

  lines.push(accent("How to play"));
  lines.push(fg("Unscramble the letters to find the hidden word."));
  lines.push(fg("You get 5 lives — make them count!"));
  lines.push("");
  lines.push(dim("/shuffle  Rearrange letters"));
  lines.push(dim("/hint     Reveal a letter"));
  lines.push(dim("/help     Show all commands"));

  const boxWidth = Math.min(termWidth - 4, 68);

  console.log();
  console.log(boxen(lines.join("\n"), {
    ...boxenTheme(),
    borderStyle: "round",
    title: accent.bold(" Anagrama "),
    titleAlignment: "center",
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    margin: { left: 2 },
    width: boxWidth,
  }));
  console.log();
}


async function doLogin(siteUrl: string, apiUrl: string, opts: { open?: boolean; label?: string }): Promise<StoredConfig | null> {
  const config = await readConfig();

  const start = await apiPost<{
    device_code?: string;
    user_code?: string;
    verification_url?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
  }>(apiUrl, "/cli/auth/start", {
    label: opts.label || "terminal",
    clientName: "anagrama-cli",
  });

  if (start.status >= 400 || !start.data.device_code || !start.data.verification_url) {
    console.log(chalk.red("Failed to start login."));
    if (start.data.error) console.log(start.data.error);
    return null;
  }

  const deviceCode = start.data.device_code;
  const userCode = start.data.user_code || "";
  const verificationUrl = start.data.verification_url;
  const intervalSec = Math.max(1, start.data.interval || 3);
  const expiresIn = Math.max(60, start.data.expires_in || 900);

  // Build manual URL (without device_code, just user_code)
  const manualUrl = `${siteUrl}/cli-auth?manual=true`;

  console.log();
  console.log(boxen(accent.bold("Link Your Account"), {
    ...boxenTheme(),
    borderStyle: "round",
    padding: { left: 3, right: 3, top: 0, bottom: 0 },
    margin: { left: 2 },
    textAlignment: "center",
  }));
  console.log();

  if (userCode) {
    console.log(chalk.gray("  Your code:"));
    console.log();
    console.log(boxen(chalk.white.bold(userCode), {
      ...boxenTheme(), borderColor: getTheme().accent,
      borderStyle: "round",
      padding: { left: 3, right: 3, top: 0, bottom: 0 },
      margin: { left: 7 },
      textAlignment: "center",
    }));
    console.log();
  }

  console.log(dim("  Option 1: ") + fg("Auto-open browser (recommended)"));
  console.log(accent(`  ${verificationUrl}`));
  console.log();
  console.log(dim("  Option 2: ") + fg("Enter code manually at:"));
  console.log(accent(`  ${manualUrl}`));
  console.log();

  if (opts.open !== false) {
    try {
      await open(verificationUrl, { wait: false });
      console.log(chalk.green("  ✓ Browser opened automatically"));
    } catch {
      console.log(chalk.yellow("  (Could not open browser - use manual option)"));
    }
  }
  console.log();

  const deadline = Date.now() + expiresIn * 1000;
  const debug = process.env.DEBUG === "1" || process.env.DEBUG === "true";
  const spinner = new ColorSpinner("Waiting for browser authorization...");

  // Allow Ctrl+C to cancel the auth loop
  let cancelled = false;
  const onSigint = () => { cancelled = true; };
  process.once("SIGINT", onSigint);

  if (!debug) {
    spinner.start();
  }

  while (Date.now() < deadline && !cancelled) {
    const poll = await apiPost<{
      status?: string;
      token?: string;
      user?: { userId?: string; username?: string | null; displayName?: string | null };
      error?: string;
    }>(apiUrl, "/cli/auth/poll", { device_code: deviceCode });

    if (debug) {
      console.log(chalk.gray(`\n[DEBUG] Poll response: status=${poll.status}, data=${JSON.stringify(poll.data)}`));
    }

    if (poll.status === 202 || poll.data.status === "pending") {
      await sleep(intervalSec * 1000);
      continue;
    }

    process.removeListener("SIGINT", onSigint);
    spinner.stop();

    if (poll.data?.token) {
      const nextConfig: StoredConfig = {
        ...config,
        baseUrl: siteUrl,
        apiUrl,
        token: poll.data.token,
        user: poll.data.user,
        updatedAt: new Date().toISOString(),
      };
      await writeConfig(nextConfig);
      return nextConfig;
    }

    console.log(chalk.red("Login failed."));
    console.log(chalk.yellow(`Status: ${poll.status}`));
    console.log(chalk.yellow(`Response: ${JSON.stringify(poll.data)}`));
    if (poll.data?.error) console.log(chalk.red(`Error: ${poll.data.error}`));
    return null;
  }

  process.removeListener("SIGINT", onSigint);
  spinner.stop();
  if (cancelled) {
    console.log(chalk.gray("\n  Login cancelled."));
  } else {
    console.log(chalk.red("Login timed out."));
  }
  return null;
}

async function doLogout(): Promise<void> {
  await deleteSecureToken();
  await writeConfig({});
  console.log(chalk.green("  Logged out. See you next time!"));
}

async function doWhoami(config: StoredConfig): Promise<void> {
  if (!config.token) {
    console.log("Not logged in.");
    return;
  }
  const name = config.user?.displayName || config.user?.username || "Player";
  const username = config.user?.username || "—";
  const userId = config.user?.userId || "—";
  const lastLogin = config.updatedAt ? new Date(config.updatedAt).toLocaleString() : "—";

  const lines: string[] = [];
  lines.push(dim("Display Name:  ") + fg.bold(name));
  lines.push(dim("Username:      ") + fg("@" + username));
  lines.push(dim("User ID:       ") + dim(userId));
  lines.push(dim("Server:        ") + accent(config.baseUrl || DEFAULT_SITE_URL));
  lines.push(dim("Last Login:    ") + fg(lastLogin));

  console.log();
  console.log(boxen(lines.join("\n"), {
    ...boxenTheme(),
    borderStyle: "round",
    title: accent.bold(" Account Info "),
    titleAlignment: "left",
    padding: { left: 1, right: 1, top: 1, bottom: 1 },
    margin: { left: 2 },
  }));
  console.log();
}

// Theme colors - dynamically set by applyTheme
let accent = chalk.hex("#F5A623");
let fg = chalk.hex("#FFFFFF");
let dim = chalk.hex("#888888");

function localDateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateLong(dateKey: string): string {
  try {
    const date = new Date(dateKey + "T12:00:00");
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return dateKey;
  }
}

function printGameHeader(dateKey: string, scramble: string, targetLength: number, livesLeft: number, altFound: number, minimal: boolean, usedIndices?: Set<number>, currentInput?: string): void {
  const border = chalk.hex(getTheme().border);

  if (minimal) {
    console.log();
    console.log(bgLine(dim(`  ${dateKey}`) + dim(` · `) + accent("●".repeat(livesLeft)) + dim("○".repeat(Math.max(0, 5 - livesLeft)))));
    console.log(bgLine(`  ${accent.bold(scramble.toUpperCase().split("").join(" "))}`));
    console.log();
    return;
  }

  const formattedDate = formatDateLong(dateKey);
  const maxLives = 5;

  // Game info box
  const livesDisplay = accent("●".repeat(livesLeft)) + dim("○".repeat(Math.max(0, maxLives - livesLeft)));
  const altDisplay = altFound > 0 ? dim(" · ") + accent(`${altFound} alt`) : "";

  const headerLines: string[] = [];
  headerLines.push(dim(`${formattedDate} (ET)`));
  headerLines.push(livesDisplay + altDisplay);

  console.log();
  console.log(boxen(headerLines.join("\n"), {
    ...boxenTheme(),
    borderStyle: "round",
    title: accent.bold(" Anagrama "),
    titleAlignment: "left",
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    margin: { left: 2 },
    width: 50,
  }));
  console.log();

  // Target word slots
  const inputChars = (currentInput || "").toUpperCase().split("");
  const topRow = "    " + Array(targetLength).fill(border("┌───┐")).join(" ");
  const midRow = "    " + Array(targetLength).fill(0).map((_, i) => {
    if (inputChars[i]) {
      return border("│") + accent.bold(` ${inputChars[i]} `) + border("│");
    }
    return border("│") + dim(" · ") + border("│");
  }).join(" ");
  const botRow = "    " + Array(targetLength).fill(border("└───┘")).join(" ");
  console.log(topRow);
  console.log(midRow);
  console.log(botRow);
  console.log();

  // Letter tiles
  console.log(dim("  Letters:"));
  console.log();
  const letters = scramble.toUpperCase().split("");
  const row1 = letters.slice(0, 6).map((ch, i) => renderLetterTileWithState(ch, usedIndices?.has(i) || false)).join("  ");
  const row2 = letters.slice(6).map((ch, i) => renderLetterTileWithState(ch, usedIndices?.has(i + 6) || false)).join("  ");

  console.log(`      ${row1}`);
  if (row2.trim()) {
    console.log(`        ${row2}`);
  }
  console.log();

  console.log(chalk.gray("  ─".repeat(25)));
}

// Available commands for suggestions
const COMMANDS = [
  { name: "/help", desc: "Show all commands" },
  { name: "/hint", desc: "Get a hint" },
  { name: "/exit", desc: "Return to menu" },
  { name: "/quit", desc: "Exit the app" },
  { name: "/shuffle", desc: "Shuffle the letters" },
];

function printCommands(): void {
  const lines: string[] = [];
  lines.push(accent("/help     ") + fg("Show this help"));
  lines.push(accent("/hint     ") + fg("Reveal a letter"));
  lines.push(accent("/shuffle  ") + fg("Shuffle the letters"));
  lines.push(accent("/exit     ") + fg("Return to menu"));
  lines.push(accent("/quit     ") + fg("Exit the app"));

  console.log();
  console.log(boxen(lines.join("\n"), {
    ...boxenTheme(),
    borderStyle: "round",
    title: accent.bold(" Commands "),
    titleAlignment: "left",
    padding: { left: 1, right: 1, top: 1, bottom: 1 },
    margin: { left: 2 },
  }));
  console.log();
}

function printStats(stats: GameStats): void {
  const winPct = stats.gamesPlayed > 0 ? Math.round((stats.gamesWon / stats.gamesPlayed) * 100) : 0;

  const lines: string[] = [];

  // Stats row
  lines.push(
    accent.bold(String(stats.gamesPlayed).padStart(4)) + "      " +
    accent.bold(String(winPct + "%").padStart(5)) + "      " +
    accent.bold(String(stats.currentStreak).padStart(4)) + "      " +
    accent.bold(String(stats.maxStreak).padStart(4))
  );
  lines.push(dim("Played    Win %    Streak    Best"));
  lines.push("");

  // Guess distribution bar chart
  const maxCount = Math.max(1, ...stats.guessDistribution);
  const maxBarWidth = 22;
  lines.push(dim("Guess distribution"));
  for (let i = 0; i < stats.guessDistribution.length; i++) {
    const count = stats.guessDistribution[i] || 0;
    const barLen = Math.max(1, Math.round((count / maxCount) * maxBarWidth));
    const bar = accent("\u2588".repeat(barLen));
    lines.push(dim(String(i + 1)) + " " + bar + " " + fg(String(count)));
  }

  console.log();
  console.log(boxen(lines.join("\n"), {
    ...boxenTheme(),
    borderStyle: "round",
    title: accent.bold(" Statistics "),
    titleAlignment: "left",
    padding: { left: 1, right: 1, top: 1, bottom: 1 },
    margin: { left: 2 },
  }));
  console.log();
}

async function showPostGameMenu(
  dateKey: string,
  guessHistory: { word: string; marks: string[] }[],
  won: boolean,
  attempts: number,
  maxLives: number,
): Promise<"home" | "quit"> {
  // Update stats
  const stats = await updateStats(won, attempts, dateKey);
  printStats(stats);

  // Show share preview
  const shareText = generateShareText(dateKey, guessHistory, won, maxLives);
  const previewLines = shareText.split("\n").map((l) => chalk.gray("    " + l));
  console.log(previewLines.join("\n"));
  console.log();

  // Next puzzle countdown
  console.log(chalk.gray(`  Next puzzle in ${accent(getNextPuzzleCountdown())}`));
  console.log();

  // Post-game menu
  const action = await select({
    message: "What next?",
    choices: [
      { name: "Share results", value: "share" as const },
      { name: "Home", value: "home" as const },
      { name: "Quit", value: "quit" as const },
    ],
  });

  if (action === "share") {
    const copied = await copyToClipboard(shareText);
    if (copied) {
      console.log(chalk.green("  Copied to clipboard!"));
    } else {
      console.log();
      if (process.platform === "linux") {
        console.log(chalk.yellow("  Tip: install xclip for clipboard support (sudo apt install xclip)"));
      }
      console.log(chalk.white("  Copy this:\n"));
      console.log(shareText.split("\n").map((l) => "    " + l).join("\n"));
      console.log();
    }
    // After sharing, show home/quit
    const next = await select({
      message: "What next?",
      choices: [
        { name: "Home", value: "home" as const },
        { name: "Quit", value: "quit" as const },
      ],
    });
    return next;
  }
  return action;
}

// Render letter tile - uses theme accent for active, tileFg for contrast
function renderLetterTileWithState(ch: string, used: boolean): string {
  if (used) {
    return chalk.bgHex("#333333").hex("#555555")(` ${ch.toUpperCase()} `);
  }
  const theme = getTheme();
  return chalk.bgHex(theme.accent).hex(theme.tileFg).bold(` ${ch.toUpperCase()} `);
}

// Check if a letter is available in the remaining pool
function isLetterAvailable(letter: string, pool: string[], usedIndices: Set<number>): number {
  const upperLetter = letter.toUpperCase();
  for (let i = 0; i < pool.length; i++) {
    if (!usedIndices.has(i) && pool[i].toUpperCase() === upperLetter) {
      return i;
    }
  }
  return -1;
}

// Interactive input that validates letters and shows suggestions BELOW the input
async function interactiveInput(
  pool: string[],
  onUpdate: (input: string, usedIndices: Set<number>) => void
): Promise<{ input: string; isCommand: boolean }> {
  return new Promise((resolve) => {
    let input = "";
    let isCommandMode = false;
    let selectedIndex = 0;
    let filteredCommands: typeof COMMANDS = [];
    let menuVisible = false;
    let renderedMenuLines = 0; // Track actual rendered lines
    const usedIndices = new Set<number>();

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const getFilteredCommands = () => {
      if (!isCommandMode) return [];
      return COMMANDS.filter(c => c.name.startsWith(input));
    };

    // Clear N lines below cursor using relative moves (no save/restore)
    const clearBelow = (lines: number) => {
      if (lines === 0) return;
      for (let i = 0; i < lines; i++) {
        process.stdout.write("\n\x1b[2K");
      }
      process.stdout.write(`\x1b[${lines}A`);
    };

    // Clear menu lines below cursor
    const clearMenu = () => {
      if (renderedMenuLines === 0) return;
      clearBelow(renderedMenuLines);
      menuVisible = false;
      renderedMenuLines = 0;
    };

    // Render menu below cursor (self-contained: clears old menu first)
    const renderMenu = () => {
      filteredCommands = getFilteredCommands();

      // Clear old menu lines
      clearBelow(renderedMenuLines);

      if (filteredCommands.length === 0) {
        menuVisible = false;
        renderedMenuLines = 0;
        return;
      }

      for (let i = 0; i < filteredCommands.length; i++) {
        const cmd = filteredCommands[i];
        const isSelected = i === selectedIndex;
        process.stdout.write("\n\x1b[2K");
        if (isSelected) {
          process.stdout.write(chalk.bgHex("#333333").white(`  ${cmd.name.padEnd(12)}${cmd.desc}`));
        } else {
          process.stdout.write(chalk.gray(`  ${cmd.name.padEnd(12)}`) + chalk.dim(cmd.desc));
        }
      }
      // Move back up to input line and reposition cursor
      process.stdout.write(`\x1b[${filteredCommands.length}A`);
      renderInput();
      menuVisible = true;
      renderedMenuLines = filteredCommands.length;
    };

    const renderInput = () => {
      process.stdout.write(`\r\x1b[2K`); // Clear line
      process.stdout.write(chalk.white.bold("  › ") + input);
    };

    let ctrlCShown = false;

    const handleKey = (key: string) => {
      // Ctrl+C - show message once, replace if spammed
      if (key === "\u0003") {
        if (!ctrlCShown) {
          clearMenu();
          process.stdout.write("\n\x1b[2K" + chalk.gray("  Use /exit to return to menu or /quit to exit.") + "\x1b[1A");
          renderInput();
          ctrlCShown = true;
        }
        return;
      }

      // Reset ctrlC flag on any other key
      if (ctrlCShown) {
        process.stdout.write("\n\x1b[2K\x1b[1A");
        renderInput();
        ctrlCShown = false;
      }

      // Arrow keys
      if (key === "\u001B[A") { // Up arrow
        if (isCommandMode && filteredCommands.length > 0) {
          selectedIndex = selectedIndex <= 0 ? filteredCommands.length - 1 : selectedIndex - 1;
          renderMenu();
        }
        return;
      }

      if (key === "\u001B[B") { // Down arrow
        if (isCommandMode && filteredCommands.length > 0) {
          selectedIndex = selectedIndex >= filteredCommands.length - 1 ? 0 : selectedIndex + 1;
          renderMenu();
        }
        return;
      }

      // Tab - autocomplete (only in command mode)
      if (key === "\t") {
        if (isCommandMode && selectedIndex >= 0 && selectedIndex < filteredCommands.length) {
          clearMenu();
          input = filteredCommands[selectedIndex].name;
          selectedIndex = 0;
          renderInput();
          renderMenu();
        }
        return;
      }

      // Enter
      if (key === "\r" || key === "\n") {
        if (isCommandMode && selectedIndex >= 0 && selectedIndex < filteredCommands.length) {
          input = filteredCommands[selectedIndex].name;
        }

        clearMenu();
        stdin.setRawMode(false);
        stdin.removeListener("data", handleKey);
        console.log();
        resolve({ input: input.toLowerCase(), isCommand: isCommandMode });
        return;
      }

      // Backspace
      if (key === "\u007F" || key === "\b") {
        if (input.length > 0) {
          clearMenu();

          const lastChar = input[input.length - 1];
          input = input.slice(0, -1);
          selectedIndex = 0;

          // Check if we're exiting command mode
          const wasCommandMode = isCommandMode;
          if (input === "" || !input.startsWith("/")) {
            isCommandMode = false;
            filteredCommands = [];
          }

          // Only update game display for word mode, not command mode
          if (!wasCommandMode && lastChar !== "/") {
            const upperChar = lastChar.toUpperCase();
            for (const idx of usedIndices) {
              if (pool[idx].toUpperCase() === upperChar) {
                usedIndices.delete(idx);
                break;
              }
            }
            onUpdate(input, usedIndices);
          }

          renderInput();
          if (isCommandMode) {
            renderMenu();
          }
        }
        return;
      }

      // Escape
      if (key === "\u001B" && key.length === 1) {
        clearMenu();
        input = "";
        isCommandMode = false;
        selectedIndex = 0;
        filteredCommands = [];
        usedIndices.clear();
        onUpdate(input, usedIndices);
        renderInput();
        return;
      }

      const char = key;

      // Starting a command - don't update game display
      if (char === "/" && input === "") {
        isCommandMode = true;
        input = "/";
        selectedIndex = 0;
        renderInput();
        renderMenu();
        return;
      }

      // In command mode - don't update game display
      if (isCommandMode) {
        clearMenu();
        input += char;
        selectedIndex = 0;
        renderInput();
        renderMenu();
        return;
      }

      // Word mode - only available letters
      if (/^[a-zA-Z]$/.test(char)) {
        const idx = isLetterAvailable(char, pool, usedIndices);
        if (idx !== -1) {
          usedIndices.add(idx);
          input += char.toUpperCase();
          onUpdate(input, usedIndices);
          renderInput();
        }
        return;
      }
    };

    stdin.on("data", handleKey);
    renderInput();
  });
}

async function doPlay(config: StoredConfig, minimal = false): Promise<void> {
  const apiUrl = normalizeBaseUrl(config.apiUrl || DEFAULT_API_URL);
  const token = config.token;
  const useMinimal = minimal || config.minimal || false;

  if (!token) {
    console.log("You need to log in first.");
    return;
  }

  const spinner = new ColorSpinner("Loading today's puzzle...");
  spinner.start();

  const puzzle = await apiGet<{
    id?: string;
    dateKey?: string;
    length?: number;
    scramble?: string;
    letters?: string;
    poolScramble?: string;
    maxAttempts?: number;
    session?: {
      attempts?: number;
      done?: boolean;
      win?: boolean;
      hintsUsed?: number;
      guesses?: { word: string; marks: string[]; isTarget?: boolean; isAlt?: boolean }[];
    };
    error?: string;
  }>(apiUrl, "/anagrama/api/puzzle", token);

  spinner.stop();

  if (puzzle.status >= 400 || puzzle.data?.error) {
    console.log(chalk.red("Failed to load puzzle."));
    if (puzzle.data?.error) console.log(puzzle.data.error);
    return;
  }

  const dateKey = puzzle.data.dateKey || localDateKey();
  const maxLives = 5; // Match the website - 5 lives
  const scramble = puzzle.data.scramble || puzzle.data.letters || "";
  const targetLength = puzzle.data.length || 5;

  // Restore progress from server (syncs with website)
  let done = puzzle.data.session?.done || false;
  let attempts = puzzle.data.session?.attempts || 0;
  const win = puzzle.data.session?.win || false;

  // If already completed (on website or CLI), show result + post-game menu
  if (done) {
    // Rebuild guess history from session for share text
    const prevGuesses: { word: string; marks: string[] }[] = [];
    if (Array.isArray(puzzle.data.session?.guesses)) {
      for (const g of puzzle.data.session.guesses) {
        prevGuesses.push({ word: g.word, marks: g.marks });
      }
    }

    clearScreen();
    const formattedDate = formatDateLong(dateKey);
    console.log();
    if (win) {
      console.log(chalk.green.bold("  🎉 You already solved today's puzzle!"));
      console.log(chalk.gray(`     ${formattedDate} — Solved in ${attempts} ${attempts === 1 ? "attempt" : "attempts"}`));
    } else {
      console.log(chalk.yellow("  You've already attempted today's puzzle."));
      console.log(chalk.gray(`     ${formattedDate} — Used all ${maxLives} lives`));
    }
    console.log();

    const postAction = await showPostGameMenu(dateKey, prevGuesses, win, attempts, maxLives);
    if (postAction === "quit") {
      console.log(chalk.gray("  Goodbye!"));
      process.exit(0);
    }
    return; // "home" — returns to main loop
  }

  // Restore guess history from server (syncs with website)
  const guessHistory: { word: string; marks: string[] }[] = [];
  let altFound = 0;

  if (Array.isArray(puzzle.data.session?.guesses)) {
    for (const g of puzzle.data.session.guesses) {
      guessHistory.push({ word: g.word, marks: g.marks });
      if (g.isAlt) altFound++;
    }
  }

  let currentScramble = scramble;
  const letterPool = currentScramble.toUpperCase().split("");

  // Render game with optional used letters display
  const renderGame = (shouldClear = false, usedIndices?: Set<number>, currentInput?: string) => {
    if (shouldClear) {
      clearScreen();
    }
    const livesLeft = Math.max(0, maxLives - attempts);
    printGameHeader(dateKey, currentScramble, targetLength, livesLeft, altFound, useMinimal, usedIndices, currentInput);

    // Show guess history
    if (guessHistory.length > 0) {
      if (!useMinimal) {
        console.log(chalk.gray("  Previous guesses:"));
      }
      for (const g of guessHistory) {
        console.log(`    ${renderMarks(g.word, g.marks)}`);
      }
      console.log();
    }
  };

  // Initial render with clear
  renderGame(true);

  // Print command hint
  if (!useMinimal) {
    console.log(chalk.gray("    / for shortcuts"));
  }
  console.log();

  while (!done) {
    // Interactive input with live letter tracking
    const { input: answer, isCommand } = await interactiveInput(
      letterPool,
      (input, usedIndices) => {
        // Re-render game to show used letters
        renderGame(true, usedIndices, input);
        if (!useMinimal) console.log(chalk.gray("    / for shortcuts"));
        console.log();
      }
    );

    if (!answer) continue;

    // Handle commands
    if (isCommand || answer.startsWith("/")) {
      const cmd = answer.startsWith("/") ? answer.slice(1).split(" ")[0] : answer;
      switch (cmd) {
        case "help":
        case "h":
          renderGame(true);
          printCommands();
          console.log(chalk.gray("    Press any key to continue..."));
          // Wait for a keypress before continuing
          await new Promise<void>((resolve) => {
            const stdin = process.stdin;
            stdin.setRawMode(true);
            stdin.resume();
            stdin.once("data", () => {
              stdin.setRawMode(false);
              resolve();
            });
          });
          renderGame(true);
          if (!useMinimal) console.log(chalk.gray("    / for shortcuts"));
          console.log();
          continue;
        case "hint": {
          const hintResult = await apiPost<{
            hint?: string;
            position?: number;
            letter?: string;
            message?: string;
            error?: string;
          }>(apiUrl, "/anagrama/api/hint", {}, token);

          renderGame(true);
          if (!useMinimal) console.log(chalk.gray("    / for shortcuts"));
          console.log();

          if (hintResult.status >= 400 || hintResult.data.error) {
            console.log(chalk.yellow(`  ${hintResult.data.error || hintResult.data.message || "No hints available"}`));
          } else if (hintResult.data.letter && hintResult.data.position !== undefined) {
            console.log(chalk.cyan(`  💡 Hint: Position ${hintResult.data.position + 1} is "${hintResult.data.letter.toUpperCase()}"`));
          } else if (hintResult.data.hint) {
            console.log(chalk.cyan(`  💡 ${hintResult.data.hint}`));
          } else if (hintResult.data.message) {
            console.log(chalk.yellow(`  ${hintResult.data.message}`));
          }
          console.log();
          continue;
        }
        case "exit":
        case "back":
        case "menu":
          console.log(chalk.gray("  Returning to menu..."));
          return;
        case "quit":
        case "q":
          console.log(chalk.gray("  Goodbye!"));
          process.exit(0);
        case "shuffle":
        case "s":
          // Shuffle letters visually
          currentScramble = currentScramble.split("").sort(() => Math.random() - 0.5).join("");
          letterPool.length = 0;
          letterPool.push(...currentScramble.toUpperCase().split(""));
          renderGame(true);
          if (!useMinimal) console.log(chalk.gray("    / for shortcuts"));
          console.log();
          // Print message below input
          process.stdout.write("\n" + chalk.gray("  Letters shuffled!") + "\x1b[1A\r");
          continue;
        default:
          renderGame(true);
          if (!useMinimal) console.log(chalk.gray("    / for shortcuts"));
          console.log();
          // Print message below input
          process.stdout.write("\n" + chalk.yellow(`  Unknown command: /${cmd}. Type /help for commands.`) + "\x1b[1A\r");
          continue;
      }
    }

    const result = await apiPost<{
      validWord?: boolean;
      accepted?: boolean;
      valid?: boolean;
      isTarget?: boolean;
      isAltAnagram?: boolean;
      marks?: string[];
      attempts?: number;
      done?: boolean;
      message?: string;
    }>(apiUrl, "/anagrama/api/guess", { guess: answer }, token);

    if (result.status >= 500) {
      renderGame(true);
      if (!useMinimal) console.log(chalk.gray("    / for shortcuts"));
      console.log();
      console.log(chalk.red("  Server error."));
      break;
    }

    const marks = result.data.marks || [];

    // Track alternate anagrams
    if (result.data.isAltAnagram || (result.data.accepted && !result.data.isTarget)) {
      altFound++;
    }

    // Add to history if it was a valid attempt with marks
    if (marks.length > 0) {
      guessHistory.push({ word: answer, marks });
    }

    // Only count attempts for wrong guesses (not alt anagrams)
    if (!result.data.accepted && !result.data.isAltAnagram) {
      attempts = result.data.attempts ?? (attempts + 1);
    }
    done = result.data.done ?? done;

    // Re-render with updated stats
    renderGame(true);
    if (!useMinimal) console.log(chalk.gray("    / for shortcuts"));
    console.log();

    // Show guess result inline
    if (marks.length > 0) {
      console.log(`    ${renderMarks(answer, marks)}`);
    }

    // Show result message
    if (result.data.message) {
      const msg = result.data.message;
      if (result.data.isTarget) {
        // Will show victory below
      } else if (result.data.isAltAnagram || result.data.accepted) {
        console.log(chalk.cyan(`    ✓ ${msg}`));
      } else if (msg.includes("Not") || msg.includes("Invalid")) {
        console.log(chalk.red(`    ✗ ${msg}`));
      } else {
        console.log(chalk.yellow(`    ${msg}`));
      }
    }

    // Show lives remaining after wrong guess
    if (!result.data.accepted && !result.data.isAltAnagram && !done) {
      const livesLeft = Math.max(0, maxLives - attempts);
      console.log(chalk.gray(`    Lives: `) + accent("●".repeat(livesLeft)) + chalk.gray("○".repeat(Math.max(0, 5 - livesLeft))));
    }

    console.log();

    if (done) {
      const isWin = !!result.data.isTarget;
      if (isWin) {
        console.log(chalk.bold.green("  🎉 You found it!"));
        console.log(chalk.gray(`     The word was: ${chalk.white.bold(answer.toUpperCase())}`));
      } else {
        console.log(chalk.yellow("  Game over. Better luck next time!"));
      }
      console.log();

      // Show stats, share, and post-game menu
      const postAction = await showPostGameMenu(dateKey, guessHistory, isWin, attempts, maxLives);
      if (postAction === "quit") {
        console.log(chalk.gray("  Goodbye!"));
        process.exit(0);
      }
      return; // "home" — returns to main loop
    }
  }
}

async function mainLoop(): Promise<void> {
  // Migrate any existing plain-text tokens to secure storage
  await migrateCredentials();

  // Load theme from config, or auto-detect on first launch
  const initConfig = await readConfig();
  if (initConfig.theme && THEMES[initConfig.theme]) {
    applyTheme(initConfig.theme);
  } else {
    // First launch: detect system dark/light mode and pick a matching theme
    const systemTheme = await detectSystemTheme();
    const defaultTheme = systemTheme === "light" ? "light" : "amber";
    applyTheme(defaultTheme);
    initConfig.theme = defaultTheme;
    await writeConfig(initConfig);
  }

  // Check for updates (non-blocking)
  const availableUpdate = await checkForUpdate();
  if (availableUpdate) {
    installUpdateInBackground(availableUpdate);
  }

  let running = true;

  while (running) {
    const config = await readConfig();
    // Re-apply theme in case settings changed it
    if (config.theme && THEMES[config.theme]) {
      applyTheme(config.theme);
    }
    const useMinimal = globalMinimal || config.minimal || false;

    // Sync server puzzle status each time (catches website completions, clears on logout)
    if (config.token) {
      try {
        const apiUrl = normalizeBaseUrl(config.apiUrl || DEFAULT_API_URL);
        const puzzle = await apiGet<{
          dateKey?: string;
          session?: { done?: boolean; win?: boolean; attempts?: number };
        }>(apiUrl, "/anagrama/api/puzzle", config.token);
        if (puzzle.status < 400 && puzzle.data.session?.done) {
          const serverDateKey = puzzle.data.dateKey || localDateKey();
          const currentStats = await readStats();
          if (currentStats.lastPlayedDate !== serverDateKey) {
            // New day — use updateStats for proper counter tracking
            await updateStats(
              puzzle.data.session.win || false,
              puzzle.data.session.attempts || 0,
              serverDateKey,
            );
          } else if (puzzle.data.session.win && !currentStats.lastPlayedWon) {
            // Same day, but server says won (e.g. solved on website) — sync win status
            currentStats.lastPlayedWon = true;
            currentStats.lastPlayedAttempts = puzzle.data.session.attempts || currentStats.lastPlayedAttempts;
            await writeStats(currentStats);
          }
        }
      } catch {
        // Network error — skip, local stats will be used
      }
    }

    const stats = await readStats();
    const todayKey = localDateKey();
    const solvedToday = !!config.token && stats.lastPlayedDate === todayKey && stats.lastPlayedWon;

    clearScreen();
    printHomescreen(config, useMinimal);

    // Show "already solved" banner
    if (solvedToday) {
      const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      console.log(boxen(
        chalk.green.bold("🎉 You already solved today's puzzle!") + "\n" +
        dim(`${dateStr} — Solved in ${stats.lastPlayedAttempts} attempt${stats.lastPlayedAttempts === 1 ? "" : "s"}`),
        {
          ...boxenTheme(),
          borderStyle: "round",
          padding: { left: 1, right: 1, top: 0, bottom: 0 },
          margin: { left: 2 },
        }
      ));
      console.log();
    }

    // Show fun update banner
    const quip = UPDATE_QUIPS[Math.floor(Math.random() * UPDATE_QUIPS.length)];
    if (updateInstalledVersion) {
      console.log(boxen(
        accent.bold(`${quip}`) + "\n" +
        fg(`v${updateInstalledVersion} is ready`) + dim(" — restart to play!"),
        {
          ...boxenTheme(), borderColor: getTheme().accent,
          borderStyle: "round",
          padding: { left: 1, right: 1, top: 0, bottom: 0 },
          margin: { left: 2 },
        }
      ));
      console.log();
    } else if (pendingUpdateVersion && updateFailed) {
      console.log(boxen(
        accent.bold(`${quip}`) + "\n" +
        fg(`v${pendingUpdateVersion} available`) + dim(" — run: ") + accent("npm i -g anagrama"),
        {
          ...boxenTheme(), borderColor: getTheme().accent,
          borderStyle: "round",
          padding: { left: 1, right: 1, top: 0, bottom: 0 },
          margin: { left: 2 },
        }
      ));
      console.log();
    } else if (pendingUpdateVersion) {
      console.log(boxen(
        accent.bold(`${quip}`) + "\n" +
        fg(`v${pendingUpdateVersion}`) + dim(" is installing..."),
        {
          ...boxenTheme(), borderColor: getTheme().accent,
          borderStyle: "round",
          padding: { left: 1, right: 1, top: 0, bottom: 0 },
          margin: { left: 2 },
        }
      ));
      console.log();
    }

    // Abort menu on terminal resize to re-render at new size
    const resizeCtrl = new AbortController();
    const onResize = () => resizeCtrl.abort();
    process.stdout.on('resize', onResize);

    try {
      if (!config.token) {
        // Not logged in
        const action = await select({
          message: "What would you like to do?",
          choices: [
            { name: "Log in to Anagrama", value: "login" },
            { name: "Exit", value: "exit" },
          ],
        }, { signal: resizeCtrl.signal });

        process.stdout.removeListener('resize', onResize);

        if (action === "login") {
          const siteUrl = normalizeBaseUrl(DEFAULT_SITE_URL);
          const apiUrl = normalizeBaseUrl(DEFAULT_API_URL);
          const newConfig = await doLogin(siteUrl, apiUrl, { open: true });
          if (newConfig) {
            const name = newConfig.user?.displayName || newConfig.user?.username || "Player";
            console.log();
            console.log(chalk.green.bold("  " + getRandomWelcome(name)));
            console.log();
            await sleep(2000);
          } else {
            console.log(chalk.gray("\nPress Enter to continue..."));
            await sleep(2000);
          }
        } else {
          running = false;
          console.log(chalk.gray("  Goodbye!"));
        }
      } else {
        // Logged in - homescreen already shows welcome
        const action = await select({
          message: "What would you like to do?",
          choices: [
            { name: solvedToday ? "✅ Play today's puzzle" : "Play today's puzzle", value: "play" },
            { name: "View stats", value: "stats" },
            { name: "Leaderboard", value: "leaderboard" },
            { name: "Settings", value: "settings" },
            { name: "Account info", value: "whoami" },
            { name: "Log out", value: "logout" },
            { name: "Exit", value: "exit" },
          ],
        }, { signal: resizeCtrl.signal });

        process.stdout.removeListener('resize', onResize);

        switch (action) {
          case "play":
            await doPlay(config, globalMinimal);
            break;
          case "leaderboard":
            await open("https://playanagrama.com/leaderboards");
            break;
          case "stats": {
            const stats = await readStats();
            printStats(stats);
            console.log(chalk.gray("  Press Enter to continue..."));
            const rl3 = readline.createInterface({ input: process.stdin, output: process.stdout });
            await rl3.question("");
            rl3.close();
            break;
          }
          case "settings":
            await doSettings(config);
            break;
          case "whoami": {
            await doWhoami(config);
            console.log(chalk.gray("  Press Enter to continue..."));
            const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
            await rl2.question("");
            rl2.close();
            break;
          }
          case "logout": {
            const confirmLogout = await select({
              message: "Are you sure you want to log out?",
              choices: [
                { name: "Yes, log out", value: true },
                { name: "Cancel", value: false },
              ],
            });
            if (confirmLogout) {
              await doLogout();
              await sleep(1000);
            }
            break;
          }
          case "exit":
            running = false;
            console.log(chalk.gray("  Goodbye! Come back tomorrow for a new puzzle."));
            break;
        }
      }
    } catch {
      // Terminal resized - re-render at new size
      process.stdout.removeListener('resize', onResize);
      continue;
    }
  }
}

// Global minimal mode flag
let globalMinimal = false;

// Commander setup for direct command invocations
const program = new Command();

program
  .name("anagrama")
  .description("Terminal client for Anagrama")
  .version(CURRENT_VERSION)
  .option("-m, --minimal", "Use minimal output mode (less visual clutter)")
  .action(async (opts) => {
    globalMinimal = opts.minimal || false;
    await mainLoop();
  });

program
  .command("login")
  .description("Link your Anagrama account")
  .option("-u, --url <url>", "Frontend base URL")
  .option("--no-open", "Do not open the browser automatically")
  .option("-l, --label <label>", "Label for this device")
  .action(async (opts) => {
    const config = await readConfig();
    const siteUrl = normalizeBaseUrl(opts.url || config.baseUrl || DEFAULT_SITE_URL);
    const apiUrl = normalizeBaseUrl(config.apiUrl || DEFAULT_API_URL);
    const newConfig = await doLogin(siteUrl, apiUrl, { open: opts.open, label: opts.label });
    if (newConfig) {
      const name = newConfig.user?.displayName || newConfig.user?.username || "Player";
      console.log(chalk.green.bold(getRandomWelcome(name)));
    }
  });

program
  .command("logout")
  .description("Remove local credentials")
  .action(async () => {
    await doLogout();
  });

program
  .command("whoami")
  .description("Show current login")
  .action(async () => {
    const config = await readConfig();
    await doWhoami(config);
  });

program
  .command("play")
  .description("Play the daily Anagrama puzzle")
  .option("-u, --url <url>", "API base URL")
  .option("-m, --minimal", "Use minimal output mode")
  .action(async (opts) => {
    const config = await readConfig();
    if (opts.url) {
      config.apiUrl = normalizeBaseUrl(opts.url);
    }
    await doPlay(config, opts.minimal);
  });

program.parseAsync(process.argv);
