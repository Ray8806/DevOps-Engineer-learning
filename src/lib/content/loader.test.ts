import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTENT_DIR, ContentError, loadContent } from "./loader";

const tmpDirs: string[] = [];

/** Copies the real content tree so a test can break one thing in it. */
function copyOfContent(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "content-"));
  fs.cpSync(CONTENT_DIR, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

// Test fixtures are edited loosely on purpose, to produce invalid shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function editJson(file: string, edit: (data: any) => void) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(data);
  fs.writeFileSync(file, JSON.stringify(data));
}

function problemsOf(dir: string): string[] {
  try {
    loadContent(dir);
  } catch (err) {
    if (err instanceof ContentError) return err.problems;
    throw err;
  }
  return [];
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("real content", () => {
  it("loads without problems", () => {
    const content = loadContent();
    expect(content.stages.length).toBeGreaterThan(0);
    expect(content.units.has("object-storage")).toBe(true);
  });

  it("gives every unit a lesson and a quiz", () => {
    for (const unit of loadContent().units.values()) {
      expect(unit.lesson.length).toBeGreaterThan(0);
      expect(unit.quiz.length).toBeGreaterThan(0);
    }
  });
});

describe("broken content is rejected", () => {
  const unit = (dir: string, file: string) => path.join(dir, "units", "object-storage", file);

  it("rejects an unknown field in unit.json", () => {
    const dir = copyOfContent();
    editJson(unit(dir, "unit.json"), (d) => (d.titel = "typo"));
    expect(problemsOf(dir).join("\n")).toMatch(/unit\.json.*titel/);
  });

  it("rejects a missing required field", () => {
    const dir = copyOfContent();
    editJson(unit(dir, "unit.json"), (d) => delete d.title);
    expect(problemsOf(dir).join("\n")).toMatch(/unit\.json: title/);
  });

  it("rejects an answer that is not an option", () => {
    const dir = copyOfContent();
    editJson(unit(dir, "quiz.json"), (d) => (d.questions[0].answer = ["z"]));
    expect(problemsOf(dir).join("\n")).toMatch(/answer "z" is not an option id/);
  });

  it("rejects a single-choice question with two answers", () => {
    const dir = copyOfContent();
    editJson(unit(dir, "quiz.json"), (d) => (d.questions[0].answer = ["a", "b"]));
    expect(problemsOf(dir).join("\n")).toMatch(/exactly one answer/);
  });

  it("rejects an option without an explanation", () => {
    const dir = copyOfContent();
    editJson(unit(dir, "quiz.json"), (d) => delete d.questions[0].options[0].explanation);
    expect(problemsOf(dir).join("\n")).toMatch(/options\.0\.explanation/);
  });

  it("rejects duplicate question ids", () => {
    const dir = copyOfContent();
    editJson(unit(dir, "quiz.json"), (d) => (d.questions[1].id = d.questions[0].id));
    expect(problemsOf(dir).join("\n")).toMatch(/already used/);
  });

  it("rejects a lesson missing a declared provider section", () => {
    const dir = copyOfContent();
    const file = unit(dir, "lesson.mdx");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('<Provider name="gcp">', "<div>").replace(/<\/Provider>\s*<\/ProviderTabs>/, "</div></ProviderTabs>"));
    expect(problemsOf(dir).join("\n")).toMatch(/no <Provider name="gcp"> section/);
  });

  it("rejects an unknown prerequisite", () => {
    const dir = copyOfContent();
    editJson(unit(dir, "unit.json"), (d) => (d.prerequisites = ["does-not-exist"]));
    expect(problemsOf(dir).join("\n")).toMatch(/unknown prerequisite "does-not-exist"/);
  });

  it("rejects a stage listing an unknown unit", () => {
    const dir = copyOfContent();
    editJson(path.join(dir, "stages.json"), (d) => d.stages[0].units.push("ghost-unit"));
    expect(problemsOf(dir).join("\n")).toMatch(/unknown unit "ghost-unit"/);
  });

  it("rejects a unit whose stage disagrees with stages.json", () => {
    const dir = copyOfContent();
    editJson(unit(dir, "unit.json"), (d) => (d.stage = 3));
    expect(problemsOf(dir).join("\n")).toMatch(/stage is 3 but stages\.json lists it under stage 1/);
  });

  it("rejects a lab check with both exists and equals", () => {
    const dir = copyOfContent();
    editJson(unit(dir, "labs/s3-create-bucket.json"), (d) => (d.steps[0].check.equals = 1));
    expect(problemsOf(dir).join("\n")).toMatch(/exactly one of/);
  });

  it("rejects malformed JSON and reports every problem at once", () => {
    const dir = copyOfContent();
    fs.writeFileSync(unit(dir, "quiz.json"), "{ not json");
    editJson(path.join(dir, "stages.json"), (d) => d.stages[0].units.push("ghost-unit"));
    const problems = problemsOf(dir);
    expect(problems.some((p) => p.includes("not valid JSON"))).toBe(true);
    expect(problems.some((p) => p.includes("ghost-unit"))).toBe(true);
  });
});
