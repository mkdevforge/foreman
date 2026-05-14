import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../cli/errors";

export const HOOK_COMMAND_TIMEOUT_SECONDS = 180;
export const INSTALL_TOOLS = ["claude-code", "codex", "all"] as const;

export type InstallTool = (typeof INSTALL_TOOLS)[number];

export interface InstallForemanHooksOptions {
  tool: InstallTool;
  homeDir?: string;
  claudeHookPath?: string;
  codexHookPath?: string;
}

export interface InstallForemanHooksResult {
  installed_tools: Array<"claude-code" | "codex">;
  claude_settings_path: string | null;
  codex_hooks_path: string | null;
  codex_config_path: string | null;
}

interface CommandHook {
  type: "command";
  command: string;
  timeout: number;
}

export function parseInstallTool(value: string | undefined): InstallTool {
  const tool = value ?? "all";
  if (!INSTALL_TOOLS.includes(tool as InstallTool)) {
    throw new CliError(2, "invalid_tool", `invalid tool '${tool}'; expected one of claude-code, codex, all`);
  }

  return tool as InstallTool;
}

export function installForemanHooks(options: InstallForemanHooksOptions): InstallForemanHooksResult {
  const homeDir = options.homeDir ?? homedir();
  const installedTools: Array<"claude-code" | "codex"> = [];
  let claudeSettingsPath: string | null = null;
  let codexHooksPath: string | null = null;
  let codexConfigPath: string | null = null;

  if (options.tool === "claude-code" || options.tool === "all") {
    claudeSettingsPath = installClaudeCodeHook({
      homeDir,
      hookPath: options.claudeHookPath ?? defaultHookBinaryPath("foreman-hook-stop-claude-code")
    });
    installedTools.push("claude-code");
  }

  if (options.tool === "codex" || options.tool === "all") {
    const codexInstall = installCodexHook({
      homeDir,
      hookPath: options.codexHookPath ?? defaultHookBinaryPath("foreman-hook-stop-codex")
    });
    codexHooksPath = codexInstall.hooksPath;
    codexConfigPath = codexInstall.configPath;
    installedTools.push("codex");
  }

  return {
    installed_tools: installedTools,
    claude_settings_path: claudeSettingsPath,
    codex_hooks_path: codexHooksPath,
    codex_config_path: codexConfigPath
  };
}

export function installClaudeCodeHook(input: { homeDir: string; hookPath: string }): string {
  const settingsPath = join(input.homeDir, ".claude", "settings.json");
  const settings = readJsonObject(settingsPath);

  upsertStopHook(settings, "foreman-hook-stop-claude-code", {
    type: "command",
    command: quoteShellArg(input.hookPath),
    timeout: HOOK_COMMAND_TIMEOUT_SECONDS
  });
  writeJsonObject(settingsPath, settings);

  return settingsPath;
}

export function installCodexHook(input: { homeDir: string; hookPath: string }): { hooksPath: string; configPath: string } {
  const hooksPath = join(input.homeDir, ".codex", "hooks.json");
  const configPath = join(input.homeDir, ".codex", "config.toml");
  const hooksConfig = readJsonObject(hooksPath);

  upsertStopHook(hooksConfig, "foreman-hook-stop-codex", {
    type: "command",
    command: quoteShellArg(input.hookPath),
    timeout: HOOK_COMMAND_TIMEOUT_SECONDS
  });
  writeJsonObject(hooksPath, hooksConfig);
  ensureCodexHooksFeature(configPath);

  return { hooksPath, configPath };
}

export function ensureCodexHooksFeature(configPath: string): boolean {
  const existingText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const parsed = existingText.trim().length === 0 ? {} : parseToml(existingText, configPath);
  const features = isRecord(parsed.features) ? parsed.features : {};

  if (features.hooks === true) {
    return false;
  }

  const updatedText = setTomlFeature(existingText, "hooks", "true");
  mkdirSync(dirname(configPath), { recursive: true });
  atomicWriteFile(configPath, updatedText);
  return true;
}

function upsertStopHook(settings: Record<string, unknown>, binaryName: string, hook: CommandHook): void {
  const hooksRoot = ensureRecord(settings, "hooks");
  const stopGroups = ensureArray(hooksRoot, "Stop");

  for (let index = stopGroups.length - 1; index >= 0; index -= 1) {
    const group = stopGroups[index];
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      continue;
    }

    const hooks = group.hooks as unknown[];
    group.hooks = hooks.filter((candidate) => !isForemanHook(candidate, binaryName));
    if ((group.hooks as unknown[]).length === 0 && Object.keys(group).length === 1) {
      stopGroups.splice(index, 1);
    }
  }

  stopGroups.push({ hooks: [hook] });
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(1, "invalid_hook_config", `${path}: failed to parse JSON: ${errorMessage(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new CliError(1, "invalid_hook_config", `${path}: expected a JSON object`);
  }

  return parsed;
}

function writeJsonObject(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value === undefined) {
    const record: Record<string, unknown> = {};
    parent[key] = record;
    return record;
  }

  if (!isRecord(value)) {
    throw new CliError(1, "invalid_hook_config", `hook config field '${key}' must be an object`);
  }

  return value;
}

function ensureArray(parent: Record<string, unknown>, key: string): unknown[] {
  const value = parent[key];
  if (value === undefined) {
    const array: unknown[] = [];
    parent[key] = array;
    return array;
  }

  if (!Array.isArray(value)) {
    throw new CliError(1, "invalid_hook_config", `hook config field '${key}' must be an array`);
  }

  return value;
}

function isForemanHook(candidate: unknown, binaryName: string): boolean {
  return isRecord(candidate) && typeof candidate.command === "string" && candidate.command.includes(binaryName);
}

function parseToml(text: string, path: string): Record<string, unknown> {
  try {
    const toml = (Bun as unknown as { TOML: { parse: (input: string) => unknown } }).TOML.parse(text);
    if (!isRecord(toml)) {
      throw new Error("expected TOML document to parse to an object");
    }

    return toml;
  } catch (error) {
    throw new CliError(1, "invalid_hook_config", `${path}: failed to parse TOML: ${errorMessage(error)}`);
  }
}

function setTomlFeature(text: string, key: string, value: string): string {
  const lines = text.length === 0 ? [] : text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }

  const featuresIndex = lines.findIndex((line) => /^\s*\[features]\s*(?:#.*)?$/.test(line));
  if (featuresIndex === -1) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("[features]", `${key} = ${value}`);
    return `${lines.join("\n")}\n`;
  }

  let nextSectionIndex = lines.length;
  for (let index = featuresIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+]\s*(?:#.*)?$/.test(lines[index])) {
      nextSectionIndex = index;
      break;
    }
  }

  for (let index = featuresIndex + 1; index < nextSectionIndex; index += 1) {
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(lines[index])) {
      lines[index] = `${key} = ${value}`;
      return `${lines.join("\n")}\n`;
    }
  }

  lines.splice(featuresIndex + 1, 0, `${key} = ${value}`);
  return `${lines.join("\n")}\n`;
}

function defaultHookBinaryPath(binaryName: "foreman-hook-stop-claude-code" | "foreman-hook-stop-codex"): string {
  return fileURLToPath(new URL(`../../${binaryName}`, import.meta.url));
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function atomicWriteFile(path: string, body: string): void {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);

  try {
    writeFileSync(tempPath, body, { encoding: "utf8", flag: "wx" });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
