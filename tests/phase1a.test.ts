import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];
const isoUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-test-"));
  tempDirs.push(dir);
  return dir;
}

function createGitRepo(): string {
  const dir = createTempDir();
  const result = Bun.spawnSync({
    cmd: ["git", "init"],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe"
  });

  if (result.exitCode !== 0) {
    throw new Error(decodeOutput(result.stderr));
  }

  return dir;
}

function runForeman(cwd: string, argv: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, foremanBin, ...argv],
    cwd,
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

function initForeman(repo: string): void {
  const result = runForeman(repo, ["init"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
}

function addTask(repo: string, id = "FOREMAN-1", title = "Implement repo task store"): void {
  const result = runForeman(repo, ["task", "add", id, "--title", title]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
}

function readTaskYaml(repo: string, id = "FOREMAN-1"): Record<string, any> {
  return parse(readFileSync(join(repo, ".foreman", "tasks", `${id}.yaml`), "utf8")) as Record<string, any>;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("foreman repo task store", () => {
  test("initializes .foreman in a temporary Git repo", () => {
    const repo = createGitRepo();
    const result = runForeman(repo, ["init"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Initialized Foreman");
    expect(result.stderr).toBe("");
    expect(statSync(join(repo, ".foreman", "tasks")).isDirectory()).toBe(true);
    expect(existsSync(join(repo, ".foreman", "README.md"))).toBe(true);
    expect(readdirSync(join(repo, ".foreman", "tasks"))).toEqual([]);
  });

  test("fails clearly outside a Git repo", () => {
    const dir = createTempDir();
    const result = runForeman(dir, ["init"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Git repository");
  });

  test("adds a task and writes explicit null optional fields", () => {
    const repo = createGitRepo();

    initForeman(repo);
    addTask(repo);

    const yamlPath = join(repo, ".foreman", "tasks", "FOREMAN-1.yaml");
    const yamlText = readFileSync(yamlPath, "utf8");
    const task = parse(yamlText) as Record<string, any>;

    expect(yamlText).toContain("source_ref: null");
    expect(yamlText).toContain("description: null");
    expect(task.schema_version).toBe(1);
    expect(task.id).toBe("FOREMAN-1");
    expect(task.status).toBe("todo");
    expect(task.source_ref).toBeNull();
    expect(task.description).toBeNull();
    expect(task.created_at).toMatch(isoUtcPattern);
    expect(task.updated_at).toMatch(isoUtcPattern);
    expect(task.chunks).toEqual([]);
  });

  test("rejects invalid task IDs", () => {
    const repo = createGitRepo();

    initForeman(repo);
    const result = runForeman(repo, ["task", "add", "bad/id", "--title", "Bad ID"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid task id");
  });

  test("updates task status", () => {
    const repo = createGitRepo();

    initForeman(repo);
    addTask(repo);
    const result = runForeman(repo, ["task", "status", "FOREMAN-1", "review"]);
    const task = readTaskYaml(repo);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Updated task FOREMAN-1 status to review\n");
    expect(task.status).toBe("review");
    expect(task.updated_at).toMatch(isoUtcPattern);
  });

  test("adds a chunk with a spec file", () => {
    const repo = createGitRepo();
    const specPath = join(repo, "spec.md");

    initForeman(repo);
    addTask(repo);
    writeFileSync(specPath, "Build the YAML-backed task store.\n\nKeep the CLI small.\n");
    const result = runForeman(repo, [
      "chunk",
      "add",
      "FOREMAN-1/yaml-store",
      "--title",
      "Build YAML task store",
      "--spec-file",
      specPath
    ]);
    const task = readTaskYaml(repo);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Added chunk FOREMAN-1/yaml-store\n");
    expect(task.chunks).toHaveLength(1);
    expect(task.chunks[0]).toMatchObject({
      id: "yaml-store",
      title: "Build YAML task store",
      spec: "Build the YAML-backed task store.\n\nKeep the CLI small.\n",
      status: "todo",
      stage: "discovery",
      notes: []
    });
    expect(task.chunks[0].created_at).toMatch(isoUtcPattern);
    expect(task.chunks[0].updated_at).toMatch(isoUtcPattern);
  });

  test("rejects duplicate and invalid chunk IDs", () => {
    const repo = createGitRepo();

    initForeman(repo);
    addTask(repo);
    expect(runForeman(repo, ["chunk", "add", "FOREMAN-1/yaml-store", "--title", "One"]).exitCode).toBe(0);

    const duplicate = runForeman(repo, ["chunk", "add", "FOREMAN-1/yaml-store", "--title", "Two"]);
    const invalid = runForeman(repo, ["chunk", "add", "FOREMAN-1/YAMLStore", "--title", "Bad"]);

    expect(duplicate.exitCode).toBe(2);
    expect(duplicate.stderr).toContain("already exists");
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toContain("invalid chunk id");
  });

  test("lists tasks and chunks with stable text output", () => {
    const repo = createGitRepo();

    initForeman(repo);
    addTask(repo, "FOREMAN-2", "Second task");
    addTask(repo, "FOREMAN-1", "First task");
    expect(runForeman(repo, ["task", "status", "FOREMAN-2", "doing"]).exitCode).toBe(0);
    expect(runForeman(repo, ["chunk", "add", "FOREMAN-1/yaml-store", "--title", "YAML store"]).exitCode).toBe(0);

    const taskList = runForeman(repo, ["task", "list"]);
    const filteredTaskList = runForeman(repo, ["task", "list", "--status", "doing"]);
    const chunkList = runForeman(repo, ["chunk", "list", "FOREMAN-1"]);

    expect(taskList.stdout).toBe("FOREMAN-1  todo  First task\nFOREMAN-2  doing  Second task\n");
    expect(filteredTaskList.stdout).toBe("FOREMAN-2  doing  Second task\n");
    expect(chunkList.stdout).toBe("yaml-store  todo  discovery  YAML store\n");
  });

  test("shows tasks with stable text output", () => {
    const repo = createGitRepo();

    initForeman(repo);
    addTask(repo);
    expect(runForeman(repo, ["chunk", "add", "FOREMAN-1/yaml-store", "--title", "YAML store"]).exitCode).toBe(0);

    const result = runForeman(repo, ["task", "show", "FOREMAN-1"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Task FOREMAN-1\n");
    expect(result.stdout).toContain("Status: todo\n");
    expect(result.stdout).toContain("Source: null\n");
    expect(result.stdout).toContain("Description:\n  null\n");
    expect(result.stdout).toContain("  yaml-store  todo  discovery  YAML store\n");
  });

  test("emits JSON envelopes with schema version and nullable fields", () => {
    const repo = createGitRepo();

    initForeman(repo);
    addTask(repo);
    expect(runForeman(repo, ["chunk", "add", "FOREMAN-1/yaml-store", "--title", "YAML store"]).exitCode).toBe(0);

    const taskShow = JSON.parse(runForeman(repo, ["task", "show", "FOREMAN-1", "--json"]).stdout);
    const taskList = JSON.parse(runForeman(repo, ["task", "list", "--json"]).stdout);
    const chunkList = JSON.parse(runForeman(repo, ["chunk", "list", "FOREMAN-1", "--json"]).stdout);

    expect(taskShow.schema_version).toBe(1);
    expect(taskShow.task.source_ref).toBeNull();
    expect(taskShow.task.description).toBeNull();
    expect(taskShow.task.created_at).toMatch(isoUtcPattern);
    expect(taskList.schema_version).toBe(1);
    expect(taskList.tasks[0].id).toBe("FOREMAN-1");
    expect(chunkList.schema_version).toBe(1);
    expect(chunkList.task_id).toBe("FOREMAN-1");
    expect(chunkList.chunks[0].id).toBe("yaml-store");
  });
});
