import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CertSchema,
  LabSchema,
  QuizFileSchema,
  StagesFileSchema,
  UnitMetaSchema,
  PROVIDERS,
  type Cert,
  type Lab,
  type Question,
  type Stage,
  type UnitMeta,
} from "./schema";

export const CONTENT_DIR = path.join(process.cwd(), "content");

export interface Unit {
  meta: UnitMeta;
  /** Raw MDX source of lesson.mdx. */
  lesson: string;
  quiz: Question[];
  labs: Lab[];
}

export interface Content {
  stages: Stage[];
  units: Map<string, Unit>;
  certs: Map<string, Cert>;
}

/** Thrown with every problem found, so one build shows all content errors. */
export class ContentError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Invalid content (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "ContentError";
  }
}

function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Reads and validates everything under `contentDir`.
 * Collects all schema and cross-reference problems, then throws once.
 */
export function loadContent(contentDir: string = CONTENT_DIR): Content {
  const problems: string[] = [];
  const rel = (file: string) => path.relative(contentDir, file);

  function readJson<S extends z.ZodType>(file: string, schema: S): z.output<S> | undefined {
    if (!fs.existsSync(file)) {
      problems.push(`${rel(file)}: file is missing`);
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      problems.push(`${rel(file)}: not valid JSON (${(err as Error).message})`);
      return undefined;
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const where = issue.path.length ? issue.path.join(".") : "(root)";
        problems.push(`${rel(file)}: ${where}: ${issue.message}`);
      }
      return undefined;
    }
    return result.data;
  }

  // --- certs (optional until the certification phase adds them)
  const certs = new Map<string, Cert>();
  for (const dir of listDirs(path.join(contentDir, "certs"))) {
    const file = path.join(contentDir, "certs", dir, "cert.json");
    const cert = readJson(file, CertSchema);
    if (!cert) continue;
    if (cert.id !== dir) problems.push(`${rel(file)}: id "${cert.id}" must match directory "${dir}"`);
    certs.set(cert.id, cert);
  }

  // --- units
  const units = new Map<string, Unit>();
  const questionOwner = new Map<string, string>();
  const labOwner = new Map<string, string>();

  for (const dir of listDirs(path.join(contentDir, "units"))) {
    const unitDir = path.join(contentDir, "units", dir);
    const metaFile = path.join(unitDir, "unit.json");
    const meta = readJson(metaFile, UnitMetaSchema);
    if (!meta) continue;
    if (meta.id !== dir) problems.push(`${rel(metaFile)}: id "${meta.id}" must match directory "${dir}"`);

    const unitProviders = PROVIDERS.filter((p) => meta.providers[p]);
    const providerAllowed = (p: string) => p === "general" || (unitProviders as string[]).includes(p);

    // lesson.mdx
    const lessonFile = path.join(unitDir, "lesson.mdx");
    let lesson = "";
    if (!fs.existsSync(lessonFile)) {
      problems.push(`${rel(lessonFile)}: file is missing`);
    } else {
      lesson = fs.readFileSync(lessonFile, "utf8");
      if (!lesson.trim()) problems.push(`${rel(lessonFile)}: lesson is empty`);
      for (const p of unitProviders) {
        if (!new RegExp(`<Provider\\s+name="${p}"`).test(lesson)) {
          problems.push(`${rel(lessonFile)}: unit declares provider "${p}" but has no <Provider name="${p}"> section`);
        }
      }
      for (const m of lesson.matchAll(/<Provider\s+name="([^"]*)"/g)) {
        if (!(unitProviders as string[]).includes(m[1])) {
          problems.push(`${rel(lessonFile)}: <Provider name="${m[1]}"> is not declared in unit.json providers`);
        }
      }
      if (/<Compare\b/.test(lesson) && meta.compare.length === 0) {
        problems.push(`${rel(lessonFile)}: uses <Compare /> but unit.json has no "compare" rows`);
      }
    }

    // quiz.json
    const quizFile = path.join(unitDir, "quiz.json");
    const quiz = readJson(quizFile, QuizFileSchema)?.questions ?? [];
    for (const q of quiz) {
      const prev = questionOwner.get(q.id);
      if (prev) problems.push(`${rel(quizFile)}: question id "${q.id}" is already used in ${prev}`);
      questionOwner.set(q.id, rel(quizFile));
      if (q.unitId !== meta.id) {
        problems.push(`${rel(quizFile)}: question "${q.id}" must have unitId "${meta.id}"`);
      }
      if (!providerAllowed(q.provider)) {
        problems.push(`${rel(quizFile)}: question "${q.id}" uses provider "${q.provider}" not declared by the unit`);
      }
      for (const c of q.certs) checkCertDomain(`${rel(quizFile)}: question "${q.id}"`, c.id, c.domain);
    }

    // labs/*.json
    const labs: Lab[] = [];
    const labsDir = path.join(unitDir, "labs");
    const labFiles = fs.existsSync(labsDir)
      ? fs.readdirSync(labsDir).filter((f) => f.endsWith(".json")).sort()
      : [];
    for (const f of labFiles) {
      const labFile = path.join(labsDir, f);
      const lab = readJson(labFile, LabSchema);
      if (!lab) continue;
      if (`${lab.id}.json` !== f) problems.push(`${rel(labFile)}: id "${lab.id}" must match file name`);
      const prev = labOwner.get(lab.id);
      if (prev) problems.push(`${rel(labFile)}: lab id "${lab.id}" is already used in ${prev}`);
      labOwner.set(lab.id, rel(labFile));
      if (!providerAllowed(lab.provider)) {
        problems.push(`${rel(labFile)}: provider "${lab.provider}" is not declared by the unit`);
      }
      labs.push(lab);
    }

    for (const ref of meta.certDomains) {
      const [certId, domain] = ref.split(":");
      checkCertDomain(`${rel(metaFile)}: certDomains "${ref}"`, certId, Number(domain));
    }

    units.set(meta.id, { meta, lesson, quiz, labs });
  }

  /** Domain numbers can only be checked once that cert's cert.json exists. */
  function checkCertDomain(where: string, certId: string, domain: number) {
    const cert = certs.get(certId);
    if (cert && !cert.domains.some((d) => d.id === domain)) {
      problems.push(`${where}: cert "${certId}" has no domain ${domain}`);
    }
  }

  // --- stages + cross references
  const stages = readJson(path.join(contentDir, "stages.json"), StagesFileSchema)?.stages ?? [];
  const stageOfUnit = new Map<string, number>();
  const stageIds = new Set<number>();
  for (const stage of stages) {
    if (stageIds.has(stage.id)) problems.push(`stages.json: duplicate stage id ${stage.id}`);
    stageIds.add(stage.id);
    for (const unitId of stage.units) {
      if (stageOfUnit.has(unitId)) problems.push(`stages.json: unit "${unitId}" is listed more than once`);
      stageOfUnit.set(unitId, stage.id);
      if (!units.has(unitId)) problems.push(`stages.json: stage ${stage.id} lists unknown unit "${unitId}"`);
    }
  }
  for (const { meta } of units.values()) {
    const listed = stageOfUnit.get(meta.id);
    if (listed === undefined) {
      problems.push(`units/${meta.id}/unit.json: unit is not listed in any stage of stages.json`);
    } else if (listed !== meta.stage) {
      problems.push(`units/${meta.id}/unit.json: stage is ${meta.stage} but stages.json lists it under stage ${listed}`);
    }
    for (const pre of meta.prerequisites) {
      if (pre === meta.id) problems.push(`units/${meta.id}/unit.json: unit cannot be its own prerequisite`);
      else if (!units.has(pre)) problems.push(`units/${meta.id}/unit.json: unknown prerequisite "${pre}"`);
    }
  }

  if (problems.length) throw new ContentError(problems);
  return { stages, units, certs };
}

let cached: Content | undefined;

/** Content for pages. Memoised in production; re-read on every call in dev. */
export function getContent(): Content {
  if (process.env.NODE_ENV !== "production") return loadContent();
  return (cached ??= loadContent());
}
