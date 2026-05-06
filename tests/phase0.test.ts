import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runForemanCli } from "../src/cli/runtime";
import { runForemanHook } from "../src/hook/runtime";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const decoder = new TextDecoder();

function runCli(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const result = runForemanCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    }
  });

  return { ...result, stdout, stderr };
}

async function runHook(
  argv: string[],
  name: "foreman-hook-stop-claude-code" | "foreman-hook-stop-codex",
  options: { stdin?: string; homeDir?: string } = {}
) {
  let stdout = "";
  let stderr = "";

  const result = await runForemanHook(
    name,
    argv,
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      }
    },
    {
      stdin: () => options.stdin ?? "",
      homeDir: options.homeDir
    }
  );

  return { ...result, stdout, stderr };
}

function runPackageBin(argv: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", ...argv],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: result.exitCode,
    stdout: decodeOutput(result.stdout),
    stderr: decodeOutput(result.stderr)
  };
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}

describe("foreman CLI foundation", () => {
  test("prints help with exit 0", () => {
    const result = runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("foreman");
    expect(result.stderr).toBe("");
  });

  test("prints command-specific help with exit 0", () => {
    const result = runCli(["task", "add", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: foreman task add");
    expect(result.stdout).toContain("--title <title>");
    expect(result.stderr).toBe("");
  });

  test("returns exit 2 for unknown commands", () => {
    const result = runCli(["unknown-command"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown command");
  });

  test("returns JSON error envelope when --json appears before the command", () => {
    const result = runCli(["--json", "unknown-command"]);
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.error.exit_code).toBe(2);
    expect(parsed.error.code).toBe("unknown_command");
  });

  test("returns JSON error envelope when --json appears after the command", () => {
    const result = runCli(["unknown-command", "--json"]);
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.error.exit_code).toBe(2);
    expect(parsed.error.code).toBe("unknown_command");
  });
});

describe("package bin entrypoints", () => {
  test("foreman bin prints help", () => {
    const result = runPackageBin(["foreman", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("foreman");
    expect(result.stderr).toBe("");
  });

  test("foreman bin prints command-specific help", () => {
    const result = runPackageBin(["foreman", "task", "add", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: foreman task add");
    expect(result.stdout).toContain("--title <title>");
    expect(result.stderr).toBe("");
  });

  test("foreman bin preserves JSON error output", () => {
    const result = runPackageBin(["foreman", "--json", "unknown-command"]);
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(parsed.schema_version).toBe(1);
    expect(parsed.error.code).toBe("unknown_command");
  });

  test("hook bins print help", () => {
    const claude = runPackageBin(["foreman-hook-stop-claude-code", "--help"]);
    const codex = runPackageBin(["foreman-hook-stop-codex", "--help"]);

    expect(claude.exitCode).toBe(0);
    expect(claude.stdout).toContain("foreman-hook-stop-claude-code");
    expect(claude.stderr).toBe("");
    expect(codex.exitCode).toBe(0);
    expect(codex.stdout).toContain("foreman-hook-stop-codex");
    expect(codex.stderr).toBe("");
  });
});

describe("hook stubs", () => {
  test("claude-code hook prints help", async () => {
    const result = await runHook(["--help"], "foreman-hook-stop-claude-code");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("foreman-hook-stop-claude-code");
    expect(result.stdout).toContain("Stop hook entry point");
    expect(result.stderr).toBe("");
  });

  test("codex hook prints help", async () => {
    const result = await runHook(["--help"], "foreman-hook-stop-codex");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("foreman-hook-stop-codex");
    expect(result.stdout).toContain("Stop hook entry point");
    expect(result.stderr).toBe("");
  });

  test("hooks swallow malformed payloads and log without blocking", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "foreman-hook-foundation-"));

    try {
      const result = await runHook([], "foreman-hook-stop-codex", { stdin: "not-json", homeDir });
      const logPath = join(homeDir, ".foreman", "logs", "hook-errors.log");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, "utf8")).toContain("parse_payload_json");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
