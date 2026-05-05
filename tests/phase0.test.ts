import { describe, expect, test } from "bun:test";
import { runForemanCli } from "../src/cli/runtime";
import { runHookStub } from "../src/hook/runtime";

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

function runHook(argv: string[], name: "foreman-hook-stop-claude-code" | "foreman-hook-stop-codex") {
  let stdout = "";
  let stderr = "";
  const result = runHookStub(name, argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    }
  });

  return { ...result, stdout, stderr };
}

describe("foreman CLI foundation", () => {
  test("prints help with exit 0", () => {
    const result = runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("foreman");
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

describe("hook stubs", () => {
  test("claude-code hook prints help", () => {
    const result = runHook(["--help"], "foreman-hook-stop-claude-code");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("foreman-hook-stop-claude-code");
    expect(result.stdout).toContain("Phase 0 stub");
    expect(result.stderr).toBe("");
  });

  test("codex hook prints help", () => {
    const result = runHook(["--help"], "foreman-hook-stop-codex");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("foreman-hook-stop-codex");
    expect(result.stdout).toContain("Phase 0 stub");
    expect(result.stderr).toBe("");
  });

  test("hook stubs return not implemented without writing domain files", () => {
    const result = runHook([], "foreman-hook-stop-codex");
    const parsed = JSON.parse(runHook(["--json"], "foreman-hook-stop-codex").stderr);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not implemented");
    expect(parsed.schema_version).toBe(1);
    expect(parsed.error.code).toBe("not_implemented");
  });
});
