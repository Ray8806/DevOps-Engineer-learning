import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { allFilled, correctAnswers, fill, runChallenge } from "./run";

const { challenges } = loadContent();

describe("fill", () => {
  it("replaces every blank and leaves unknown ones", () => {
    expect(fill("a {{x}} b {{x}} {{y}}", { x: "1" })).toBe("a 1 b 1 {{y}}");
  });
});

describe("every challenge", () => {
  it("exists", () => {
    expect(challenges.length).toBeGreaterThan(0);
  });

  for (const challenge of challenges) {
    describe(challenge.id, () => {
      const answers = correctAnswers(challenge);

      it("is cleared with the correct answers", () => {
        const run = runChallenge(challenge, answers);
        const failed = run.failedAt === null ? null : run.commands[run.failedAt];
        expect(failed && `${failed.command}\n${failed.lines.map((l) => l.text).join("\n")}`).toBeNull();
        expect(run.goals.filter((g) => !g.passed).map((g) => g.description)).toEqual([]);
        expect(run.cleared).toBe(true);
      });

      // A wrong choice that still "works" would teach the wrong thing.
      for (const blank of challenge.blanks) {
        for (const choice of blank.choices.filter((c) => c !== blank.answer)) {
          it(`fails with ${blank.id} = ${choice}`, () => {
            expect(runChallenge(challenge, { ...answers, [blank.id]: choice }).cleared).toBe(false);
          });
        }
      }

      it("needs every blank filled", () => {
        const partial = Object.fromEntries(Object.entries(answers).filter(([id]) => id !== challenge.blanks[0].id));
        expect(allFilled(challenge, partial)).toBe(false);
        expect(allFilled(challenge, answers)).toBe(true);
      });
    });
  }
});
