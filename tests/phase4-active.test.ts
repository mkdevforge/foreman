import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

describe("Phase 4 active work context CLI", () => {
  test("work writes valid active context with default project path", () => {
    const { controlRepo, homeDir } = setupControlRepo();

    const result = runForeman(controlRepo, homeDir, ["work", "FOREMAN-1/yaml-store"]);
    const active = readActive(homeDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Set active Foreman work context");
    expect(active).toMatchObject({
      schema_version: 1,
      task_id: "FOREMAN-1",
      chunk_id: "yaml-store",
      stage: "discovery",
      stage_override: null,
      control_repo_root: controlRepo,
      project_path: controlRepo
    });
  });

  test("work --project records sibling worktree root and --stage does not mutate YAML", () => {
    const root = createTempDir();
    const homeDir = createTempDir();
    const controlRepo = createGitRepo(join(root, "control"));
    const siblingRepo = createGitRepo(join(root, "agent"));

    initTaskAndChunk(controlRepo, homeDir);
    const result = runForeman(controlRepo, homeDir, [
      "work",
      "FOREMAN-1/yaml-store",
      "--stage",
      "implement",
      "--project",
      "../agent"
    ]);
    const active = readActive(homeDir);
    const task = parse(readFileSync(join(controlRepo, ".foreman", "tasks", "FOREMAN-1.yaml"), "utf8")) as any;

    expect(result.exitCode).toBe(0);
    expect(active.stage).toBe("implement");
    expect(active.stage_override).toBe("implement");
    expect(active.control_repo_root).toBe(controlRepo);
    expect(active.project_path).toBe(siblingRepo);
    expect(task.chunks[0].stage).toBe("discovery");
  });

  test("status reports active, stale, and malformed contexts without DB writes", () => {
    const { controlRepo, homeDir } = setupControlRepo();

    expect(runForeman(controlRepo, homeDir, ["work", "FOREMAN-1/yaml-store"]).exitCode).toBe(0);
    const freshStatus = runForeman(controlRepo, homeDir, ["status", "--json"]);
    expect(JSON.parse(freshStatus.stdout)).toMatchObject({
      active: {
        task_id: "FOREMAN-1",
        chunk_id: "yaml-store"
      },
      stale: false,
      stale_after_hours: 24
    });

    const active = readActive(homeDir);
    writeFileSync(activePath(homeDir), `${JSON.stringify({ ...active, created_at: "2000-01-01T00:00:00.000Z" })}\n`);
    const staleStatus = runForeman(controlRepo, homeDir, ["status"]);
    expect(staleStatus.exitCode).toBe(0);
    expect(staleStatus.stdout).toContain("Stale: yes (24h)");

    writeFileSync(activePath(homeDir), "{not-json");
    const malformedStatus = runForeman(controlRepo, homeDir, ["status", "--json"]);
    const parsedMalformed = JSON.parse(malformedStatus.stdout);
    expect(malformedStatus.exitCode).toBe(0);
    expect(parsedMalformed.active).toBeNull();
    expect(parsedMalformed.invalid.error).toContain("JSON");
  });

  test("stop clears active context and is idempotent", () => {
    const { controlRepo, homeDir } = setupControlRepo();

    expect(runForeman(controlRepo, homeDir, ["work", "FOREMAN-1/yaml-store"]).exitCode).toBe(0);
    expect(existsSync(activePath(homeDir))).toBe(true);

    const first = runForeman(controlRepo, homeDir, ["stop", "--json"]);
    const second = runForeman(controlRepo, homeDir, ["stop", "--json"]);

    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).cleared).toBe(true);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout).cleared).toBe(false);
    expect(existsSync(activePath(homeDir))).toBe(false);
  });

  test("work rejects missing chunks and invalid project paths", () => {
    const { controlRepo, homeDir } = setupControlRepo();
    const outside = createTempDir();

    const missingChunk = runForeman(controlRepo, homeDir, ["work", "FOREMAN-1/missing"]);
    const invalidProject = runForeman(controlRepo, homeDir, [
      "work",
      "FOREMAN-1/yaml-store",
      "--project",
      outside
    ]);

    expect(missingChunk.exitCode).toBe(2);
    expect(missingChunk.stderr).toContain("chunk 'FOREMAN-1/missing' was not found");
    expect(invalidProject.exitCode).toBe(2);
    expect(invalidProject.stderr).toContain("Git repository");
  });
});

function setupControlRepo(): { controlRepo: string; homeDir: string } {
  const controlRepo = createGitRepo(createTempDir());
  const homeDir = createTempDir();
  initTaskAndChunk(controlRepo, homeDir);
  return { controlRepo, homeDir };
}

function initTaskAndChunk(controlRepo: string, homeDir: string): void {
  expect(runForeman(controlRepo, homeDir, ["init"]).exitCode).toBe(0);
  expect(runForeman(controlRepo, homeDir, ["task", "add", "FOREMAN-1", "--title", "Task"]).exitCode).toBe(0);
  expect(
    runForeman(controlRepo, homeDir, ["chunk", "add", "FOREMAN-1/yaml-store", "--title", "YAML store"]).exitCode
  ).toBe(0);
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase4-active-"));
  tempDirs.push(dir);
  return dir;
}

function createGitRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  const result = Bun.spawnSync({
    cmd: ["git", "init"],
    cwd: path,
    stdout: "pipe",
    stderr: "pipe"
  });

  if (result.exitCode !== 0) {
    throw new Error(decodeOutput(result.stderr));
  }

  return realpathSync(path);
}

function runForeman(cwd: string, homeDir: string, argv: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, foremanBin, ...argv],
    cwd,
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

function activePath(homeDir: string): string {
  return join(homeDir, ".foreman", "active.json");
}

function readActive(homeDir: string): any {
  return JSON.parse(readFileSync(activePath(homeDir), "utf8"));
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
