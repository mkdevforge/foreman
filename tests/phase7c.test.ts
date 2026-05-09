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
const decisionIdPattern = /^d_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const oldTimestamp = "2026-01-01T00:00:00.000Z";
const existingDecisionId1 = "d_019f0000-0000-7000-8000-000000000001";
const existingDecisionId3 = "d_019f0000-0000-7000-8000-000000000003";

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase7c-test-"));
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

function setupRepo(): string {
  const repo = createGitRepo();

  expect(runForeman(repo, ["init"]).exitCode).toBe(0);
  expect(runForeman(repo, ["task", "add", "FOREMAN-7", "--title", "Dispatch readiness"]).exitCode).toBe(0);
  expect(runForeman(repo, ["chunk", "add", "FOREMAN-7/decisions", "--title", "Decisions"]).exitCode).toBe(0);

  return repo;
}

function taskYamlPath(repo: string): string {
  return join(repo, ".foreman", "tasks", "FOREMAN-7.yaml");
}

function readTaskYaml(repo: string): Record<string, any> {
  return parse(readFileSync(taskYamlPath(repo), "utf8")) as Record<string, any>;
}

function writeTaskYaml(repo: string, task: Record<string, any>): void {
  writeFileSync(taskYamlPath(repo), stringify(task), "utf8");
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

describe("Phase 7c decision CLI", () => {
  test("adds and lists chunk decisions with prefixed UUIDv7 ids", () => {
    const repo = setupRepo();

    forceOldTimestamps(repo);
    const first = runForeman(repo, ["decision", "add", "FOREMAN-7/decisions", "Use CLI JSON as the UI boundary."]);
    const second = runForeman(repo, ["decision", "add", "FOREMAN-7/decisions", "Keep decisions append-only for now."]);
    const list = runForeman(repo, ["decision", "list", "FOREMAN-7/decisions"]);
    const task = readTaskYaml(repo);
    const decisions = task.chunks[0].decisions;
    const firstId = decisions[0].id;
    const secondId = decisions[1].id;

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe(`Added decision ${firstId} to FOREMAN-7/decisions\n`);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe(`Added decision ${secondId} to FOREMAN-7/decisions\n`);
    expect(firstId).toMatch(decisionIdPattern);
    expect(secondId).toMatch(decisionIdPattern);
    expect(secondId).not.toBe(firstId);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(`${firstId}  `);
    expect(list.stdout).toContain("Use CLI JSON as the UI boundary.");
    expect(list.stdout).toContain(`${secondId}  `);
    expect(list.stdout).toContain("Keep decisions append-only for now.");
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      id: firstId,
      body: "Use CLI JSON as the UI boundary."
    });
    expect(decisions[0].decided_at).toMatch(isoUtcPattern);
    expect(decisions[0].author).toBeUndefined();
    expect(decisions[1]).toMatchObject({
      id: secondId,
      body: "Keep decisions append-only for now."
    });
    expect(decisions[1].decided_at).toMatch(isoUtcPattern);
    expect(decisions[1].author).toBeUndefined();
    expect(task.updated_at).toBe(task.chunks[0].updated_at);
    expect(task.updated_at).not.toBe(oldTimestamp);
  });

  test("emits UI-friendly JSON for add and list", () => {
    const repo = setupRepo();

    const added = JSON.parse(
      runForeman(repo, ["decision", "add", "FOREMAN-7/decisions", "Use explicit decision JSON.", "--json"]).stdout
    );
    const listed = JSON.parse(runForeman(repo, ["decision", "list", "FOREMAN-7/decisions", "--json"]).stdout);

    expect(added).toMatchObject({
      schema_version: 1,
      task_id: "FOREMAN-7",
      chunk_id: "decisions",
      decision: {
        body: "Use explicit decision JSON."
      }
    });
    expect(added.decision.id).toMatch(decisionIdPattern);
    expect(added.decision.decided_at).toMatch(isoUtcPattern);
    expect(added.decision.author).toBeUndefined();
    expect(added.chunk).not.toHaveProperty("decisions");
    expect(listed).toEqual({
      schema_version: 1,
      task_id: "FOREMAN-7",
      chunk_id: "decisions",
      decisions: [added.decision]
    });
  });

  test("reports an empty decision list clearly", () => {
    const repo = setupRepo();

    const text = runForeman(repo, ["decision", "list", "FOREMAN-7/decisions"]);
    const json = JSON.parse(runForeman(repo, ["decision", "list", "FOREMAN-7/decisions", "--json"]).stdout);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toBe("No decisions found.\n");
    expect(json.decisions).toEqual([]);
  });

  test("preserves existing decision and chunk metadata while adding", () => {
    const repo = setupRepo();
    const task = readTaskYaml(repo);

    task.chunks[0].custom_chunk_field = "preserved";
    task.chunks[0].decisions = [
      {
        id: existingDecisionId1,
        body: "Existing decision.",
        decided_at: "2026-05-07T18:00:00.000Z",
        source: "ui"
      }
    ];
    writeTaskYaml(repo, task);

    expect(runForeman(repo, ["decision", "add", "FOREMAN-7/decisions", "New decision."]).exitCode).toBe(0);
    const after = readTaskYaml(repo);

    expect(after.chunks[0].custom_chunk_field).toBe("preserved");
    expect(after.chunks[0].decisions[0].source).toBe("ui");
    expect(after.chunks[0].decisions.map((decision: any) => decision.id)[0]).toBe(existingDecisionId1);
    expect(after.chunks[0].decisions.map((decision: any) => decision.id)[1]).toMatch(decisionIdPattern);
    expect(after.chunks[0].decisions.map((decision: any) => decision.id)[1]).not.toBe(existingDecisionId1);
  });

  test("generates a new prefixed UUIDv7 id without reusing existing ids", () => {
    const repo = setupRepo();
    const task = readTaskYaml(repo);

    task.chunks[0].decisions = [
      {
        id: existingDecisionId1,
        body: "Existing first decision.",
        decided_at: "2026-05-07T18:00:00.000Z"
      },
      {
        id: existingDecisionId3,
        body: "Existing third decision.",
        decided_at: "2026-05-07T18:02:00.000Z"
      }
    ];
    writeTaskYaml(repo, task);

    const result = runForeman(repo, ["decision", "add", "FOREMAN-7/decisions", "New decision."]);
    const ids = readTaskYaml(repo).chunks[0].decisions.map((decision: any) => decision.id);

    expect(result.exitCode).toBe(0);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(existingDecisionId1);
    expect(ids[1]).toBe(existingDecisionId3);
    expect(ids[2]).toMatch(decisionIdPattern);
    expect(ids[2]).not.toBe(existingDecisionId1);
    expect(ids[2]).not.toBe(existingDecisionId3);
    expect(result.stdout).toBe(`Added decision ${ids[2]} to FOREMAN-7/decisions\n`);
  });

  test("fails clearly for bad references, invalid ids, duplicate ids, and empty bodies", () => {
    const repo = setupRepo();

    const missingChunk = runForeman(repo, ["decision", "list", "FOREMAN-7/missing"]);
    const emptyBody = runForeman(repo, ["decision", "add", "FOREMAN-7/decisions", "   "]);

    expect(missingChunk.exitCode).toBe(2);
    expect(missingChunk.stderr).toContain("chunk 'FOREMAN-7/missing' was not found");
    expect(emptyBody.exitCode).toBe(2);
    expect(emptyBody.stderr).toContain("decision body must not be empty");

    const task = readTaskYaml(repo);
    task.chunks[0].decisions = [
      {
        id: "d1",
        body: "Invalid id.",
        decided_at: "2026-05-07T18:00:00.000Z"
      }
    ];
    writeTaskYaml(repo, task);

    const invalidId = runForeman(repo, ["decision", "list", "FOREMAN-7/decisions"]);
    expect(invalidId.exitCode).toBe(2);
    expect(invalidId.stderr).toContain("invalid decision id 'd1'");

    task.chunks[0].decisions = [
      {
        id: existingDecisionId1,
        body: "First.",
        decided_at: "2026-05-07T18:00:00.000Z"
      },
      {
        id: existingDecisionId1,
        body: "Duplicate.",
        decided_at: "2026-05-07T18:01:00.000Z"
      }
    ];
    writeTaskYaml(repo, task);

    const duplicateIds = runForeman(repo, ["decision", "list", "FOREMAN-7/decisions"]);
    expect(duplicateIds.exitCode).toBe(2);
    expect(duplicateIds.stderr).toContain(`duplicate decisions id '${existingDecisionId1}'`);
  });
});
