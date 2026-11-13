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

describe("certs", () => {
  it("loads the four certs, each with questions in every domain", () => {
    const content = loadContent();
    expect([...content.certs.keys()].sort()).toEqual(["clf-c02", "gcp-ace", "gcp-cdl", "saa-c03"]);
    for (const cert of content.certs.values()) {
      const bank = content.certQuestions.get(cert.id)!;
      for (const domain of cert.domains) {
        const count = bank.filter((q) => q.certs.some((c) => c.id === cert.id && c.domain === domain.id)).length;
        expect(count, `${cert.id} domain ${domain.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("includes unit quiz questions tagged with a cert in that cert's questions", () => {
    const bank = loadContent().certQuestions.get("saa-c03")!;
    expect(bank.some((q) => q.id === "object-storage-003")).toBe(true);
    expect(new Set(bank.map((q) => q.id)).size).toBe(bank.length);
  });

  const cert = (dir: string, file: string) => path.join(dir, "certs", "clf-c02", file);

  it("rejects domain weights that do not add up to 100", () => {
    const dir = copyOfContent();
    editJson(cert(dir, "cert.json"), (d) => (d.domains[0].weightPercent = 25));
    expect(problemsOf(dir).join("\n")).toMatch(/weights must add up to 100/);
  });

  it("rejects a question for a domain the cert does not have", () => {
    const dir = copyOfContent();
    editJson(cert(dir, "questions/starter.json"), (d) => (d.questions[0].certs[0].domain = 9));
    expect(problemsOf(dir).join("\n")).toMatch(/cert "clf-c02" has no domain 9/);
  });

  it("rejects a unit that points at a missing cert domain", () => {
    const dir = copyOfContent();
    editJson(path.join(dir, "units", "object-storage", "unit.json"), (d) => d.certDomains.push("gcp-ace:7"));
    expect(problemsOf(dir).join("\n")).toMatch(/cert "gcp-ace" has no domain 7/);
  });

  it("rejects a bank question that does not belong to its cert or platform", () => {
    const dir = copyOfContent();
    editJson(cert(dir, "questions/starter.json"), (d) => {
      d.questions[0].certs = [{ id: "saa-c03", domain: 1 }];
      d.questions[1].provider = "gcp";
    });
    const problems = problemsOf(dir).join("\n");
    expect(problems).toMatch(/must list cert "clf-c02"/);
    expect(problems).toMatch(/uses provider "gcp" but the cert is for "aws"/);
  });

  it("rejects an id shared between a bank question and a unit question, and an unknown unit link", () => {
    const dir = copyOfContent();
    editJson(cert(dir, "questions/starter.json"), (d) => {
      d.questions[0].id = "object-storage-001";
      d.questions[1].unitId = "ghost-unit";
    });
    const problems = problemsOf(dir).join("\n");
    expect(problems).toMatch(/question id "object-storage-001" is already used/);
    expect(problems).toMatch(/names unknown unit "ghost-unit"/);
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
