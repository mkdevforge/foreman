import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installForemanHooks } from "../src/hook/install";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

describe("Phase 4 hook installation", () => {
  test("install help documents user-level hook config side effects", () => {
    const homeDir = createTempDir();
    const result = runForeman(homeDir, ["install", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("~/.claude/settings.json");
    expect(result.stdout).toContain("~/.codex/hooks.json");
    expect(result.stdout).toContain("~/.codex/config.toml");
    expect(result.stdout).toContain("codex_hooks = true");
  });

  test("Claude install is idempotent and preserves unrelated settings", () => {
    const homeDir = createTempDir();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    writeFile(settingsPath, {
      theme: "dark",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo keep", timeout: 5 }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }]
      }
    });

    installForemanHooks({
      tool: "claude-code",
      homeDir,
      claudeHookPath: "/opt/foreman/foreman-hook-stop-claude-code"
    });
    installForemanHooks({
      tool: "claude-code",
      homeDir,
      claudeHookPath: "/opt/foreman/foreman-hook-stop-claude-code"
    });
    const settings = readJson(settingsPath);

    expect(settings.theme).toBe("dark");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("echo pre");
    expect(countCommands(settings.hooks.Stop, "foreman-hook-stop-claude-code")).toBe(1);
    expect(countCommands(settings.hooks.Stop, "echo keep")).toBe(1);
    expect(existsSync(join(homeDir, ".codex", "hooks.json"))).toBe(false);
  });

  test("Codex install is idempotent, preserves hooks, and enables codex_hooks TOML", () => {
    const homeDir = createTempDir();
    const hooksPath = join(homeDir, ".codex", "hooks.json");
    const configPath = join(homeDir, ".codex", "config.toml");
    writeFile(hooksPath, {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo keep", timeout: 5 }] }],
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo post" }] }]
      }
    });
    writeFileSync(configPath, '[features]\nother = false\n\n[profiles.default]\nmodel = "gpt-5.4-mini"\n');

    installForemanHooks({
      tool: "codex",
      homeDir,
      codexHookPath: "/opt/foreman/foreman-hook-stop-codex"
    });
    installForemanHooks({
      tool: "codex",
      homeDir,
      codexHookPath: "/opt/foreman/foreman-hook-stop-codex"
    });
    const hooks = readJson(hooksPath);
    const tomlText = readFileSync(configPath, "utf8");
    const toml = Bun.TOML.parse(tomlText) as any;

    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toBe("echo post");
    expect(countCommands(hooks.hooks.Stop, "foreman-hook-stop-codex")).toBe(1);
    expect(countCommands(hooks.hooks.Stop, "echo keep")).toBe(1);
    expect(toml.features.codex_hooks).toBe(true);
    expect(toml.features.other).toBe(false);
    expect(toml.profiles.default.model).toBe("gpt-5.4-mini");
    expect(existsSync(join(homeDir, ".claude", "settings.json"))).toBe(false);
  });

  test("foreman install --tool filters installed tools", () => {
    const homeDir = createTempDir();
    const result = runForeman(homeDir, ["install", "--tool", "codex", "--json"]);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.installed_tools).toEqual(["codex"]);
    expect(existsSync(join(homeDir, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(homeDir, ".claude", "settings.json"))).toBe(false);
  });
});

function writeFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function countCommands(stopGroups: any[], needle: string): number {
  let count = 0;
  for (const group of stopGroups) {
    for (const hook of group.hooks ?? []) {
      if (typeof hook.command === "string" && hook.command.includes(needle)) {
        count += 1;
      }
    }
  }
  return count;
}

function runForeman(homeDir: string, argv: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, foremanBin, ...argv],
    env: { ...process.env, HOME: homeDir },
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: result.exitCode,
    stdout: decodeOutput(result.stdout),
    stderr: decodeOutput(result.stderr)
  };
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase4-install-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});
