#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import open from "open";
import { select } from "@inquirer/prompts";
import fs from "fs/promises";
import os from "os";
import path from "path";
import readline from "readline/promises";
import process from "process";
import keytar from "keytar";
import { execFile } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version: CURRENT_VERSION } = require("../package.json") as { version: string };

const DEFAULT_SITE_URL = process.env.ANAGRAMA_URL || "https://playanagrama.com";
const DEFAULT_API_URL = process.env.ANAGRAMA_API_URL || "https://api.playanagrama.com";
const KEYCHAIN_SERVICE = "anagrama-cli";
const KEYCHAIN_ACCOUNT = "auth-token";
const CONFIG_DIR = path.join(os.homedir(), ".anagrama");
const CONFIG_PATH = path.join(CONFIG_DIR, "cli.json");
const UPDATE_PATH = path.join(CONFIG_DIR, "update.json");
const NPM_REGISTRY_URL = "https://registry.npmjs.org/anagrama/latest";
const CHECK_INTERVAL_MS = 3_600_000; // 1 hour

// Secure credential storage functions
async function getSecureToken(): Promise<string | null> {
  try {
    return await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    return null;
  }
}

async function setSecureToken(token: string): Promise<boolean> {
  try {
    await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token);
    return true;
  } catch {
    return false;
  }
}

async function deleteSecureToken(): Promise<void> {
  try {
    await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    // Ignore errors on deletion
  }
}

// Migrate existing plain-text tokens to secure storage
async function migrateTokenToKeychain(): Promise<void> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw) as StoredConfig;
    if (config.token) {
      // Token exists in plain text - migrate it
      await setSecureToken(config.token);
      // Remove token from file
      const { token, ...rest } = config;
      await fs.writeFile(CONFIG_PATH, JSON.stringify(rest, null, 2), "utf8");
      console.log(chalk.green("✓ Migrated credentials to secure storage"));
    }
  } catch {
    // No existing config or already migrated
  }
}

// Prevent Ctrl+C from killing the app - must use menu to exit
process.on("SIGINT", () => {
  // Ignore Ctrl+C - user must use menu to exit
  console.log(chalk.gray("\n  Use 'Exit' from the menu or type 'quit' to exit."));
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
};

type ApiResponse<T> = { status: number; data: T };

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

/** In-memory flag set when background install finishes during this session. */
let updateInstalledVersion: string | null = null;

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
  try {
    execFile("npm", ["install", "-g", `anagrama@${version}`], { timeout: 60_000 }, async (err) => {
      if (!err) {
        updateInstalledVersion = version;
        await writeUpdateState({
          lastCheck: new Date().toISOString(),
          latestVersion: version,
          installed: true,
        }).catch(() => {});
      }
    });
  } catch {
    // npm not found or other error - silently skip
  }
}

// ── End auto-update ──────────────────────────────────────────────────────────

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
  const termWidth = Math.min(getTermWidth(), 100);
  const boxWidth = Math.min(termWidth - 4, 72);
  const leftColWidth = Math.floor(boxWidth * 0.4);
  const rightColWidth = boxWidth - leftColWidth - 3; // -3 for divider

  const name = config.user?.displayName || config.user?.username || "Player";
  const isLoggedIn = !!config.token;

  if (minimal) {
    console.log();
    console.log(accent.bold(`  Anagrama CLI v${CURRENT_VERSION}`));
    if (isLoggedIn) {
      console.log(chalk.gray(`  Welcome back, ${chalk.white(name)}!`));
    }
    console.log();
    return;
  }

  // Top border
  console.log();
  const versionLabel = ` Anagrama CLI v${CURRENT_VERSION} `;
  console.log(chalk.gray("  ─") + chalk.white(versionLabel) + chalk.gray("─".repeat(Math.max(0, boxWidth - versionLabel.length - 1))));

  // Box top
  console.log(chalk.hex("#CC6B3D")("  ╭" + "─".repeat(boxWidth) + "╮"));

  // Welcome section (left) | Tips section (right)
  const welcomeMsg = isLoggedIn ? `Welcome back, ${name}!` : "Welcome to Anagrama!";
  const welcomePadded = welcomeMsg.padEnd(leftColWidth);

  // Tips header
  const tipsHeader = accent("Tips for getting started");

  console.log(chalk.hex("#CC6B3D")("  │") + chalk.bold.white(`  ${welcomePadded}`) + chalk.gray(" │ ") + tipsHeader + " ".repeat(Math.max(0, rightColWidth - 24)) + chalk.hex("#CC6B3D")("│"));

  // Mascot / Tips content
  const tip1 = isLoggedIn ? "Type /help during play for commands" : "Log in to save your progress";
  console.log(chalk.hex("#CC6B3D")("  │") + " ".repeat(leftColWidth + 2) + chalk.gray(" │ ") + chalk.white(tip1.padEnd(rightColWidth)) + chalk.hex("#CC6B3D")("│"));

  // ASCII art mascot
  const mascotLines = [
    "       ╭───╮       ",
    "       │ A │       ",
    "       ╰───╯       ",
    "    ╭───╮ ╭───╮    ",
    "    │ N │ │ A │    ",
    "    ╰───╯ ╰───╯    ",
  ];

  // Horizontal divider for tips
  console.log(chalk.hex("#CC6B3D")("  │") + " ".repeat(leftColWidth + 2) + chalk.gray(" │ ") + chalk.gray("─".repeat(rightColWidth)) + chalk.hex("#CC6B3D")("│"));

  // Recent activity header
  console.log(chalk.hex("#CC6B3D")("  │") + accent(mascotLines[0].padEnd(leftColWidth + 2)) + chalk.gray(" │ ") + accent("How to play") + " ".repeat(Math.max(0, rightColWidth - 11)) + chalk.hex("#CC6B3D")("│"));
  console.log(chalk.hex("#CC6B3D")("  │") + accent(mascotLines[1].padEnd(leftColWidth + 2)) + chalk.gray(" │ ") + chalk.white("Find the target word from scrambled".padEnd(rightColWidth)) + chalk.hex("#CC6B3D")("│"));
  console.log(chalk.hex("#CC6B3D")("  │") + accent(mascotLines[2].padEnd(leftColWidth + 2)) + chalk.gray(" │ ") + chalk.white("letters. You have 5 lives!".padEnd(rightColWidth)) + chalk.hex("#CC6B3D")("│"));
  console.log(chalk.hex("#CC6B3D")("  │") + accent(mascotLines[3].padEnd(leftColWidth + 2)) + chalk.gray(" │ ") + " ".repeat(rightColWidth) + chalk.hex("#CC6B3D")("│"));
  console.log(chalk.hex("#CC6B3D")("  │") + accent(mascotLines[4].padEnd(leftColWidth + 2)) + chalk.gray(" │ ") + chalk.gray("/shuffle  Rearrange letters".padEnd(rightColWidth)) + chalk.hex("#CC6B3D")("│"));
  console.log(chalk.hex("#CC6B3D")("  │") + accent(mascotLines[5].padEnd(leftColWidth + 2)) + chalk.gray(" │ ") + chalk.gray("/help     Show all commands".padEnd(rightColWidth)) + chalk.hex("#CC6B3D")("│"));

  // Server info at bottom
  const serverInfo = `  ${config.baseUrl || DEFAULT_SITE_URL}`;
  console.log(chalk.hex("#CC6B3D")("  │") + chalk.gray(serverInfo.padEnd(leftColWidth + 2)) + chalk.gray(" │ ") + " ".repeat(rightColWidth) + chalk.hex("#CC6B3D")("│"));

  // Box bottom
  console.log(chalk.hex("#CC6B3D")("  ╰" + "─".repeat(boxWidth) + "╯"));
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
  console.log(chalk.bold.cyan("  ╭─────────────────────────────────────────╮"));
  console.log(chalk.bold.cyan("  │") + chalk.bold("           Link Your Account            ") + chalk.bold.cyan("│"));
  console.log(chalk.bold.cyan("  ╰─────────────────────────────────────────╯"));
  console.log();

  if (userCode) {
    console.log(chalk.gray("  Your code:"));
    console.log();
    console.log(chalk.bold.yellow(`       ╔═══════════════════╗`));
    console.log(chalk.bold.yellow(`       ║   ${chalk.white.bold(userCode)}   ║`));
    console.log(chalk.bold.yellow(`       ╚═══════════════════╝`));
    console.log();
  }

  console.log(chalk.gray("  Option 1: ") + chalk.white("Auto-open browser (recommended)"));
  console.log(chalk.blue(`  ${verificationUrl}`));
  console.log();
  console.log(chalk.gray("  Option 2: ") + chalk.white("Enter code manually at:"));
  console.log(chalk.blue(`  ${manualUrl}`));
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

  if (!debug) {
    spinner.start();
  }

  while (Date.now() < deadline) {
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

  spinner.stop();
  console.log(chalk.red("Login timed out."));
  return null;
}

async function doLogout(): Promise<void> {
  await deleteSecureToken();
  await writeConfig({});
  console.log(chalk.green("Logged out. See you next time!"));
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

  console.log();
  console.log(chalk.bold.cyan("  ╭─────────────────────────────────╮"));
  console.log(chalk.bold.cyan("  │") + chalk.bold("         Account Info           ") + chalk.bold.cyan("│"));
  console.log(chalk.bold.cyan("  ╰─────────────────────────────────╯"));
  console.log();
  console.log(`  ${chalk.gray("Display Name:")}  ${chalk.white.bold(name)}`);
  console.log(`  ${chalk.gray("Username:")}      ${chalk.white("@" + username)}`);
  console.log(`  ${chalk.gray("User ID:")}       ${chalk.gray(userId)}`);
  console.log(`  ${chalk.gray("Server:")}        ${chalk.blue(config.baseUrl || DEFAULT_SITE_URL)}`);
  console.log(`  ${chalk.gray("Last Login:")}    ${chalk.white(lastLogin)}`);
  console.log();
}

// Accent color - matching the site's yellow/amber
const accent = chalk.hex("#F5A623"); // Amber/gold like the site

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
  if (minimal) {
    console.log();
    console.log(chalk.gray(`  ${dateKey}`) + chalk.gray(` • Lives: ${accent("●".repeat(livesLeft))}${chalk.gray("○".repeat(Math.max(0, 5 - livesLeft)))}`));
    console.log(`  ${accent.bold(scramble.toUpperCase().split("").join(" "))}`);
    console.log();
    return;
  }

  const formattedDate = formatDateLong(dateKey);

  // Header
  console.log();
  console.log(accent.bold("  ╔════════════════════════════════════════════════════════╗"));
  console.log(accent.bold("  ║") + chalk.bold.white("                      Anagrama                          ") + accent.bold("║"));
  console.log(accent.bold("  ╚════════════════════════════════════════════════════════╝"));
  console.log();
  console.log(chalk.gray(`  Find the target word. Puzzle for ${chalk.white(formattedDate)} (ET)`));
  console.log();

  // Stats row
  const livesDisplay = accent("●").repeat(livesLeft) + chalk.gray("○".repeat(Math.max(0, 5 - livesLeft)));
  console.log(chalk.gray("  Lives ") + livesDisplay + chalk.gray("                    Alt anagrams found: ") + accent(String(altFound)));
  console.log();

  // Divider
  console.log(chalk.gray("  ─────────────────────────────────────────────────────────"));
  console.log();

  // Target word slots - show current input if provided
  console.log(chalk.gray("  Find the target word:"));
  console.log();
  const inputChars = (currentInput || "").toUpperCase().split("");
  const topRow = "    " + Array(targetLength).fill(chalk.white("┌───┐")).join(" ");
  const midRow = "    " + Array(targetLength).fill(0).map((_, i) => {
    if (inputChars[i]) {
      return chalk.white("│") + accent.bold(` ${inputChars[i]} `) + chalk.white("│");
    }
    return chalk.white("│") + chalk.gray(" ? ") + chalk.white("│");
  }).join(" ");
  const botRow = "    " + Array(targetLength).fill(chalk.white("└───┘")).join(" ");
  console.log(topRow);
  console.log(midRow);
  console.log(botRow);
  console.log();

  // Letter tiles - show used ones as grayed out
  console.log(chalk.gray("  Available letters:"));
  console.log();
  const letters = scramble.toUpperCase().split("");
  const row1 = letters.slice(0, 6).map((ch, i) => renderLetterTileWithState(ch, usedIndices?.has(i) || false)).join("  ");
  const row2 = letters.slice(6).map((ch, i) => renderLetterTileWithState(ch, usedIndices?.has(i + 6) || false)).join("  ");

  console.log(`      ${row1}`);
  if (row2.trim()) {
    console.log(`        ${row2}`);
  }
  console.log();

  // Divider
  console.log(chalk.gray("  ─────────────────────────────────────────────────────────"));
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
  console.log();
  console.log(accent.bold("  Commands:"));
  console.log(chalk.gray("  /help     ") + chalk.white("Show this help"));
  console.log(chalk.gray("  /hint     ") + chalk.white("Get a hint (reveals one letter)"));
  console.log(chalk.gray("  /exit     ") + chalk.white("Return to menu"));
  console.log(chalk.gray("  /quit     ") + chalk.white("Exit the app"));
  console.log(chalk.gray("  /shuffle  ") + chalk.white("Shuffle the letters (visual only)"));
  console.log();
}

// Render letter tile - can show as used (grayed out)
function renderLetterTileWithState(ch: string, used: boolean): string {
  if (used) {
    return chalk.bgHex("#444444").hex("#666666")(` ${ch.toUpperCase()} `);
  }
  return chalk.bgHex("#E5E5E5").hex("#333333").bold(` ${ch.toUpperCase()} `);
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

    // Clear menu lines below cursor
    const clearMenu = () => {
      if (!menuVisible || renderedMenuLines === 0) return;
      // Save position, move down, clear each line, restore
      process.stdout.write("\x1b[s"); // Save cursor
      for (let i = 0; i < renderedMenuLines; i++) {
        process.stdout.write("\x1b[B\x1b[2K"); // Down + clear line
      }
      process.stdout.write("\x1b[u"); // Restore cursor
      menuVisible = false;
      renderedMenuLines = 0;
    };

    // Render menu below cursor
    const renderMenu = () => {
      filteredCommands = getFilteredCommands();
      if (filteredCommands.length === 0) {
        menuVisible = false;
        return;
      }

      process.stdout.write("\x1b[s"); // Save cursor position
      for (let i = 0; i < filteredCommands.length; i++) {
        const cmd = filteredCommands[i];
        const isSelected = i === selectedIndex;
        process.stdout.write("\n"); // Move to next line
        process.stdout.write("\x1b[2K"); // Clear line
        if (isSelected) {
          process.stdout.write(chalk.bgHex("#333333").white(`  ${cmd.name.padEnd(12)}${cmd.desc}`));
        } else {
          process.stdout.write(chalk.gray(`  ${cmd.name.padEnd(12)}`) + chalk.dim(cmd.desc));
        }
      }
      process.stdout.write("\x1b[u"); // Restore cursor position
      menuVisible = true;
      renderedMenuLines = filteredCommands.length; // Track how many we rendered
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
          // Save cursor, move down, print message, restore
          process.stdout.write("\x1b[s\n\x1b[2K" + chalk.gray("  Use /exit to return to menu or /quit to exit.") + "\x1b[u");
          ctrlCShown = true;
        }
        return;
      }

      // Reset ctrlC flag on any other key
      if (ctrlCShown) {
        // Clear the message line below
        process.stdout.write("\x1b[s\n\x1b[2K\x1b[u");
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

  const dateKey = puzzle.data.dateKey || new Date().toISOString().split("T")[0];
  const maxLives = 5; // Match the website - 5 lives
  const scramble = puzzle.data.scramble || puzzle.data.letters || "";
  const targetLength = puzzle.data.length || 5;

  // Restore progress from server (syncs with website)
  let done = puzzle.data.session?.done || false;
  let attempts = puzzle.data.session?.attempts || 0;
  const win = puzzle.data.session?.win || false;

  // If already completed (on website or CLI), show the result
  if (done) {
    console.clear();
    const formattedDate = formatDateLong(dateKey);
    console.log();
    if (win) {
      console.log(accent.bold("  ╔════════════════════════════════════════════════════════╗"));
      console.log(accent.bold("  ║") + chalk.bold.white("                  Already Solved!                        ") + accent.bold("║"));
      console.log(accent.bold("  ╚════════════════════════════════════════════════════════╝"));
      console.log();
      console.log(chalk.green.bold("  🎉 You already solved today's puzzle!"));
      console.log(chalk.gray(`     ${formattedDate}`));
      console.log();
      console.log(chalk.gray(`     Solved in ${attempts} ${attempts === 1 ? "attempt" : "attempts"}`));
    } else {
      console.log(accent.bold("  ╔════════════════════════════════════════════════════════╗"));
      console.log(accent.bold("  ║") + chalk.bold.white("                  Puzzle Complete                        ") + accent.bold("║"));
      console.log(accent.bold("  ╚════════════════════════════════════════════════════════╝"));
      console.log();
      console.log(chalk.yellow("  You've already attempted today's puzzle."));
      console.log(chalk.gray(`     ${formattedDate}`));
      console.log();
      console.log(chalk.gray(`     Used all ${maxLives} lives`));
    }
    console.log();
    console.log(chalk.gray("  Come back tomorrow for a new puzzle!"));
    console.log();
    return;
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
  const renderGame = (clearScreen = false, usedIndices?: Set<number>, currentInput?: string) => {
    if (clearScreen) {
      console.clear();
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
          process.stdout.write("\x1b[s\n" + chalk.gray("  Letters shuffled!") + "\x1b[u");
          continue;
        default:
          renderGame(true);
          if (!useMinimal) console.log(chalk.gray("    / for shortcuts"));
          console.log();
          // Print message below input
          process.stdout.write("\x1b[s\n" + chalk.yellow(`  Unknown command: /${cmd}. Type /help for commands.`) + "\x1b[u");
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
      if (result.data.isTarget) {
        console.log(chalk.bold.green("  🎉 You found it!"));
        console.log(chalk.gray(`     The word was: ${chalk.white.bold(answer.toUpperCase())}`));
      } else {
        console.log(chalk.yellow("  Game over. Better luck next time!"));
      }
      console.log();
    }
  }
}

async function mainLoop(): Promise<void> {
  // Migrate any existing plain-text tokens to secure storage
  await migrateTokenToKeychain();

  // Check for updates (non-blocking, throttled to once/hour)
  const availableUpdate = await checkForUpdate();
  if (availableUpdate) {
    installUpdateInBackground(availableUpdate);
  }

  let running = true;

  while (running) {
    const config = await readConfig();
    const useMinimal = globalMinimal || config.minimal || false;

    console.clear();
    printHomescreen(config, useMinimal);

    // Show update banner if a new version was installed
    if (updateInstalledVersion) {
      console.log(chalk.cyan("  ┌──────────────────────────────────────────┐"));
      console.log(chalk.cyan("  │") + chalk.white(`  Update installed ${chalk.bold(`v${updateInstalledVersion}`)}`.padEnd(42)) + chalk.cyan("│"));
      console.log(chalk.cyan("  │") + chalk.gray("  Restart the CLI to use it.".padEnd(42)) + chalk.cyan("│"));
      console.log(chalk.cyan("  └──────────────────────────────────────────┘"));
      console.log();
    }

    if (!config.token) {
      // Not logged in
      const action = await select({
        message: "What would you like to do?",
        choices: [
          { name: "Log in to Anagrama", value: "login" },
          { name: "Exit", value: "exit" },
        ],
      });

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
        console.log(chalk.gray("Goodbye!"));
      }
    } else {
      // Logged in - homescreen already shows welcome
      const minimalLabel = useMinimal ? "Full mode" : "Minimal mode";
      const action = await select({
        message: "What would you like to do?",
        choices: [
          { name: "Play today's puzzle", value: "play" },
          { name: "Account info", value: "whoami" },
          { name: minimalLabel, value: "toggleMinimal" },
          { name: "Log out", value: "logout" },
          { name: "Exit", value: "exit" },
        ],
      });

      switch (action) {
        case "play":
          await doPlay(config, globalMinimal);
          console.log(chalk.gray("\nPress Enter to continue..."));
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          await rl.question("");
          rl.close();
          break;
        case "whoami": {
          await doWhoami(config);
          console.log(chalk.gray("Press Enter to continue..."));
          const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
          await rl2.question("");
          rl2.close();
          break;
        }
        case "toggleMinimal": {
          const updatedConfig = await readConfig();
          updatedConfig.minimal = !useMinimal;
          await writeConfig(updatedConfig);
          break;
        }
        case "logout":
          await doLogout();
          await sleep(1000);
          break;
        case "exit":
          running = false;
          console.log(chalk.gray("Goodbye! Come back tomorrow for a new puzzle."));
          break;
      }
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

program
  .command("minimal")
  .description("Toggle minimal output mode")
  .argument("[on|off]", "Set minimal mode on or off")
  .action(async (value) => {
    const config = await readConfig();
    if (value === "on" || value === "true" || value === "1") {
      config.minimal = true;
      await writeConfig(config);
      console.log(chalk.green("Minimal mode enabled."));
    } else if (value === "off" || value === "false" || value === "0") {
      config.minimal = false;
      await writeConfig(config);
      console.log(chalk.green("Minimal mode disabled."));
    } else {
      // Toggle
      config.minimal = !config.minimal;
      await writeConfig(config);
      console.log(chalk.green(`Minimal mode ${config.minimal ? "enabled" : "disabled"}.`));
    }
  });

program.parseAsync(process.argv);
