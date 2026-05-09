import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];
const isoUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const oldTimestamp = "2026-01-01T00:00:00.000Z";

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

function runForeman(cwd: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, foremanBin, ...argv],
    cwd,
    env: { ...process.env, ...env },
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

function setupRepo(): string {
  const repo = createGitRepo();

  expect(runForeman(repo, ["init"]).exitCode).toBe(0);
  expect(runForeman(repo, ["task", "add", "FOREMAN-1", "--title", "Chunk lifecycle"]).exitCode).toBe(0);
  expect(runForeman(repo, ["chunk", "add", "FOREMAN-1/yaml-store", "--title", "YAML store"]).exitCode).toBe(0);

  return repo;
}

function readTaskYaml(repo: string): Record<string, any> {
  return parse(readFileSync(taskYamlPath(repo), "utf8")) as Record<string, any>;
}

function writeTaskYaml(repo: string, task: Record<string, any>): void {
  writeFileSync(taskYamlPath(repo), stringify(task), "utf8");
}

function taskYamlPath(repo: string): string {
  return join(repo, ".foreman", "tasks", "FOREMAN-1.yaml");
}

function forceOldTimestamps(repo: string): void {
  const task = readTaskYaml(repo);

  task.updated_at = oldTimestamp;
  task.chunks[0].updated_at = oldTimestamp;
  writeTaskYaml(repo, task);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("foreman chunk lifecycle", () => {
  test("updates chunk status and timestamps", () => {
    const repo = setupRepo();

    forceOldTimestamps(repo);
    const result = runForeman(repo, ["chunk", "status", "FOREMAN-1/yaml-store", "doing"]);
    const task = readTaskYaml(repo);
    const chunk = task.chunks[0];

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Updated chunk FOREMAN-1/yaml-store status to doing\n");
    expect(result.stderr).toBe("");
    expect(chunk.status).toBe("doing");
    expect(chunk.stage).toBe("discovery");
    expect(chunk.updated_at).toMatch(isoUtcPattern);
    expect(task.updated_at).toBe(chunk.updated_at);
    expect(chunk.updated_at).not.toBe(oldTimestamp);
  });

  test("updates chunk stage independently from status", () => {
    const repo = setupRepo();

    forceOldTimestamps(repo);
    const result = runForeman(repo, ["chunk", "stage", "FOREMAN-1/yaml-store", "implement"]);
    const task = readTaskYaml(repo);
    const chunk = task.chunks[0];

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Updated chunk FOREMAN-1/yaml-store stage to implement\n");
    expect(chunk.stage).toBe("implement");
    expect(chunk.status).toBe("todo");
    expect(task.updated_at).toBe(chunk.updated_at);
  });

  test("appends a note without repo-visible author metadata", () => {
    const repo = setupRepo();

    forceOldTimestamps(repo);
    const result = runForeman(repo, ["chunk", "note", "FOREMAN-1/yaml-store", "Ready for review."]);
    const task = readTaskYaml(repo);
    const chunk = task.chunks[0];

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Added note to chunk FOREMAN-1/yaml-store\n");
    expect(chunk.notes).toHaveLength(1);
    expect(chunk.notes[0]).toMatchObject({
      body: "Ready for review."
    });
    expect(chunk.notes[0].author).toBeUndefined();
    expect(chunk.notes[0].ts).toMatch(isoUtcPattern);
    expect(task.updated_at).toBe(chunk.updated_at);
    expect(chunk.updated_at).toBe(chunk.notes[0].ts);
  });

  test("appends notes and preserves existing notes", () => {
    const repo = setupRepo();

    expect(runForeman(repo, ["chunk", "note", "FOREMAN-1/yaml-store", "First note."]).exitCode).toBe(0);
    const result = runForeman(repo, ["chunk", "note", "FOREMAN-1/yaml-store", "Second note."]);
    const task = readTaskYaml(repo);

    expect(result.exitCode).toBe(0);
    expect(task.chunks[0].notes).toHaveLength(2);
    expect(task.chunks[0].notes[0].author).toBeUndefined();
    expect(task.chunks[0].notes[0].body).toBe("First note.");
    expect(task.chunks[0].notes[1].author).toBeUndefined();
    expect(task.chunks[0].notes[1].body).toBe("Second note.");
  });

  test("preserves legacy note author fields without exposing them in JSON", () => {
    const repo = setupRepo();
    const task = readTaskYaml(repo);

    task.chunks[0].notes = [
      {
        ts: "2026-01-02T00:00:00.000Z",
        author: "legacy",
        body: "Legacy note."
      }
    ];
    writeTaskYaml(repo, task);

    expect(runForeman(repo, ["chunk", "note", "FOREMAN-1/yaml-store", "New note."]).exitCode).toBe(0);
    const afterNote = readTaskYaml(repo);
    const shown = JSON.parse(runForeman(repo, ["task", "show", "FOREMAN-1", "--json"]).stdout);

    expect(afterNote.chunks[0].notes[0].author).toBe("legacy");
    expect(afterNote.chunks[0].notes[1].author).toBeUndefined();
    expect(shown.task.chunks[0].notes[0]).toEqual({
      ts: "2026-01-02T00:00:00.000Z",
      body: "Legacy note."
    });
  });

  test("preserves unknown task and chunk fields across repeated chunk mutations", () => {
    const repo = setupRepo();
    const task = readTaskYaml(repo);

    task.dispatch = { requires_approval: true, risk_gates: ["db-migration"] };
    task.chunks[0].future_questions = [
      { id: "q_019f0000-0000-7000-8000-000000000001", body: "Which parser owns this?" }
    ];
    task.chunks[0].run_attempts = [{ id: "attempt-1", status: "blocked" }];
    writeTaskYaml(repo, task);

    expect(runForeman(repo, ["chunk", "status", "FOREMAN-1/yaml-store", "doing"]).exitCode).toBe(0);
    expect(readTaskYaml(repo).dispatch).toEqual({ requires_approval: true, risk_gates: ["db-migration"] });
    expect(readTaskYaml(repo).chunks[0].future_questions).toEqual([
      { id: "q_019f0000-0000-7000-8000-000000000001", body: "Which parser owns this?" }
    ]);

    expect(runForeman(repo, ["chunk", "stage", "FOREMAN-1/yaml-store", "review"]).exitCode).toBe(0);
    expect(readTaskYaml(repo).chunks[0].run_attempts).toEqual([{ id: "attempt-1", status: "blocked" }]);

    expect(
      runForeman(repo, ["chunk", "note", "FOREMAN-1/yaml-store", "Preserve metadata."]).exitCode
    ).toBe(0);
    const afterNote = readTaskYaml(repo);

    expect(afterNote.dispatch).toEqual({ requires_approval: true, risk_gates: ["db-migration"] });
    expect(afterNote.chunks[0].future_questions).toEqual([
      { id: "q_019f0000-0000-7000-8000-000000000001", body: "Which parser owns this?" }
    ]);
    expect(afterNote.chunks[0].run_attempts).toEqual([{ id: "attempt-1", status: "blocked" }]);
    expect(afterNote.chunks[0].status).toBe("doing");
    expect(afterNote.chunks[0].stage).toBe("review");
    expect(afterNote.chunks[0].notes[0].body).toBe("Preserve metadata.");
  });

  test("fails clearly when chunk reference does not exist", () => {
    const repo = setupRepo();
    const result = runForeman(repo, ["chunk", "status", "FOREMAN-1/missing", "doing"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("chunk 'FOREMAN-1/missing' was not found");
  });

  test("rejects unknown note options", () => {
    const repo = setupRepo();

    const result = runForeman(repo, ["chunk", "note", "FOREMAN-1/yaml-store", "No author.", "--author", "reviewer"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown option '--author'");
  });

  test("emits JSON envelopes for chunk mutations", () => {
    const repo = setupRepo();

    const status = JSON.parse(
      runForeman(repo, ["chunk", "status", "FOREMAN-1/yaml-store", "doing", "--json"]).stdout
    );
    const stage = JSON.parse(
      runForeman(repo, ["chunk", "stage", "FOREMAN-1/yaml-store", "implement", "--json"]).stdout
    );
    const note = JSON.parse(
      runForeman(repo, [
        "chunk",
        "note",
        "FOREMAN-1/yaml-store",
        "JSON note.",
        "--json"
      ]).stdout
    );

    expect(status.schema_version).toBe(1);
    expect(status.task_id).toBe("FOREMAN-1");
    expect(status.chunk.status).toBe("doing");
    expect(stage.schema_version).toBe(1);
    expect(stage.chunk.stage).toBe("implement");
    expect(note.schema_version).toBe(1);
    expect(note.chunk.notes).toHaveLength(1);
    expect(note.note.body).toBe("JSON note.");
    expect(note.note.author).toBeUndefined();
    expect(note.note.ts).toMatch(isoUtcPattern);
  });
});
