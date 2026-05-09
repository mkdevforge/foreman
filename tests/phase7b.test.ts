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
const questionIdPattern = /^q_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const oldTimestamp = "2026-01-01T00:00:00.000Z";
const existingQuestionId1 = "q_019f0000-0000-7000-8000-000000000001";
const existingQuestionId3 = "q_019f0000-0000-7000-8000-000000000003";

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase7b-test-"));
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
  expect(runForeman(repo, ["chunk", "add", "FOREMAN-7/questions", "--title", "Questions"]).exitCode).toBe(0);

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

describe("Phase 7b question CLI", () => {
  test("adds, lists, and answers chunk questions with prefixed UUIDv7 ids", () => {
    const repo = setupRepo();

    forceOldTimestamps(repo);
    const first = runForeman(repo, ["question", "add", "FOREMAN-7/questions", "Which UI flow owns this?"]);
    const second = runForeman(repo, ["question", "add", "FOREMAN-7/questions", "What should happen next?"]);
    const afterAdds = readTaskYaml(repo);
    const firstId = afterAdds.chunks[0].questions[0].id;
    const secondId = afterAdds.chunks[0].questions[1].id;
    const list = runForeman(repo, ["question", "list", "FOREMAN-7/questions"]);
    const answer = runForeman(repo, [
      "question",
      "answer",
      "FOREMAN-7/questions",
      firstId,
      "The future UI should call this CLI JSON surface."
    ]);
    const task = readTaskYaml(repo);
    const questions = task.chunks[0].questions;

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe(`Added question ${firstId} to FOREMAN-7/questions\n`);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe(`Added question ${secondId} to FOREMAN-7/questions\n`);
    expect(firstId).toMatch(questionIdPattern);
    expect(secondId).toMatch(questionIdPattern);
    expect(secondId).not.toBe(firstId);
    expect(list.stdout).toBe(
      `${firstId}  open  Which UI flow owns this?\n${secondId}  open  What should happen next?\n`
    );
    expect(answer.exitCode).toBe(0);
    expect(answer.stdout).toBe(`Answered question ${firstId} for FOREMAN-7/questions\n`);
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({
      id: firstId,
      status: "answered",
      body: "Which UI flow owns this?",
      answer: "The future UI should call this CLI JSON surface."
    });
    expect(questions[0].asked_at).toMatch(isoUtcPattern);
    expect(questions[0].answered_at).toMatch(isoUtcPattern);
    expect(questions[1]).toMatchObject({
      id: secondId,
      status: "open",
      body: "What should happen next?",
      answered_at: null,
      answer: null
    });
    expect(task.updated_at).toBe(task.chunks[0].updated_at);
    expect(task.updated_at).not.toBe(oldTimestamp);
  });

  test("emits UI-friendly JSON for add, list, and answer", () => {
    const repo = setupRepo();

    const added = JSON.parse(
      runForeman(repo, ["question", "add", "FOREMAN-7/questions", "Which command owns questions?", "--json"]).stdout
    );
    const listed = JSON.parse(runForeman(repo, ["question", "list", "FOREMAN-7/questions", "--json"]).stdout);
    const answered = JSON.parse(
      runForeman(repo, [
        "question",
        "answer",
        "FOREMAN-7/questions",
        added.question.id,
        "foreman question",
        "--json"
      ]).stdout
    );

    expect(added).toMatchObject({
      schema_version: 1,
      task_id: "FOREMAN-7",
      chunk_id: "questions",
      question: {
        status: "open",
        body: "Which command owns questions?",
        answered_at: null,
        answer: null
      }
    });
    expect(added.question.id).toMatch(questionIdPattern);
    expect(added.question.asked_at).toMatch(isoUtcPattern);
    expect(added.chunk).not.toHaveProperty("questions");
    expect(listed.questions).toEqual([added.question]);
    expect(answered.question).toMatchObject({
      id: added.question.id,
      status: "answered",
      body: "Which command owns questions?",
      answer: "foreman question"
    });
    expect(answered.question.answered_at).toMatch(isoUtcPattern);
    expect(answered.chunk).not.toHaveProperty("questions");
  });

  test("reports an empty question list clearly", () => {
    const repo = setupRepo();

    const text = runForeman(repo, ["question", "list", "FOREMAN-7/questions"]);
    const json = JSON.parse(runForeman(repo, ["question", "list", "FOREMAN-7/questions", "--json"]).stdout);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toBe("No questions found.\n");
    expect(json.questions).toEqual([]);
  });

  test("preserves existing question and chunk metadata while answering", () => {
    const repo = setupRepo();
    const task = readTaskYaml(repo);

    task.chunks[0].custom_chunk_field = "preserved";
    task.chunks[0].questions = [
      {
        id: existingQuestionId1,
        status: "open",
        body: "Should custom metadata survive?",
        asked_at: "2026-05-07T18:00:00.000Z",
        answered_at: null,
        answer: null,
        source: "ui"
      }
    ];
    writeTaskYaml(repo, task);

    expect(runForeman(repo, ["question", "answer", "FOREMAN-7/questions", existingQuestionId1, "Yes."]).exitCode).toBe(0);
    const after = readTaskYaml(repo);

    expect(after.chunks[0].custom_chunk_field).toBe("preserved");
    expect(after.chunks[0].questions[0].source).toBe("ui");
    expect(after.chunks[0].questions[0].answer).toBe("Yes.");
  });

  test("generates a new prefixed UUIDv7 id without reusing existing ids", () => {
    const repo = setupRepo();
    const task = readTaskYaml(repo);

    task.chunks[0].questions = [
      {
        id: existingQuestionId1,
        status: "answered",
        body: "Existing first question.",
        asked_at: "2026-05-07T18:00:00.000Z",
        answered_at: "2026-05-07T18:01:00.000Z",
        answer: "Done."
      },
      {
        id: existingQuestionId3,
        status: "open",
        body: "Existing third question.",
        asked_at: "2026-05-07T18:02:00.000Z",
        answered_at: null,
        answer: null
      }
    ];
    writeTaskYaml(repo, task);

    const result = runForeman(repo, ["question", "add", "FOREMAN-7/questions", "New question."]);
    const ids = readTaskYaml(repo).chunks[0].questions.map((question: any) => question.id);

    expect(result.exitCode).toBe(0);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(existingQuestionId1);
    expect(ids[1]).toBe(existingQuestionId3);
    expect(ids[2]).toMatch(questionIdPattern);
    expect(ids[2]).not.toBe(existingQuestionId1);
    expect(ids[2]).not.toBe(existingQuestionId3);
    expect(result.stdout).toBe(`Added question ${ids[2]} to FOREMAN-7/questions\n`);
  });

  test("fails clearly for bad references, bad ids, duplicate ids, and answered questions", () => {
    const repo = setupRepo();

    expect(runForeman(repo, ["question", "add", "FOREMAN-7/questions", "Question?"]).exitCode).toBe(0);
    const questionId = readTaskYaml(repo).chunks[0].questions[0].id;
    expect(runForeman(repo, ["question", "answer", "FOREMAN-7/questions", questionId, "Answer."]).exitCode).toBe(0);

    const missingChunk = runForeman(repo, ["question", "list", "FOREMAN-7/missing"]);
    const invalidQuestionId = runForeman(repo, ["question", "answer", "FOREMAN-7/questions", "q1", "Answer."]);
    const alreadyAnswered = runForeman(repo, [
      "question",
      "answer",
      "FOREMAN-7/questions",
      questionId,
      "New answer."
    ]);
    const emptyBody = runForeman(repo, ["question", "add", "FOREMAN-7/questions", "   "]);

    expect(missingChunk.exitCode).toBe(2);
    expect(missingChunk.stderr).toContain("chunk 'FOREMAN-7/missing' was not found");
    expect(invalidQuestionId.exitCode).toBe(2);
    expect(invalidQuestionId.stderr).toContain("invalid question id 'q1'");
    expect(alreadyAnswered.exitCode).toBe(2);
    expect(alreadyAnswered.stderr).toContain(`question 'FOREMAN-7/questions#${questionId}' is already answered`);
    expect(emptyBody.exitCode).toBe(2);
    expect(emptyBody.stderr).toContain("question body must not be empty");

    const task = readTaskYaml(repo);
    task.chunks[0].questions.push({
      id: questionId,
      status: "open",
      body: "Duplicate.",
      asked_at: "2026-05-07T18:03:00.000Z",
      answered_at: null,
      answer: null
    });
    writeTaskYaml(repo, task);

    const duplicateIds = runForeman(repo, ["question", "list", "FOREMAN-7/questions"]);
    expect(duplicateIds.exitCode).toBe(2);
    expect(duplicateIds.stderr).toContain(`duplicate questions id '${questionId}'`);
  });
});
