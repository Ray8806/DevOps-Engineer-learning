import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CertSchema,
  ChallengeSchema,
  FlowSchema,
  LabSchema,
  QuizFileSchema,
  StagesFileSchema,
  UnitMetaSchema,
  PROVIDERS,
  type Cert,
  type Challenge,
  type Flow,
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
  /** Animated diagrams from flows/*.json, used in the lesson with <Flow id="…" />. */
  flows: Flow[];
}

export interface Content {
  stages: Stage[];
  units: Map<string, Unit>;
  certs: Map<string, Cert>;
  /**
   * Practice questions per cert: the cert's own bank plus every unit quiz
   * question tagged with that cert.
   */
  certQuestions: Map<string, Question[]>;
  /** Fill-in-the-blank levels, sorted by track then level. */
  challenges: Challenge[];
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

  const questionOwner = new Map<string, string>();
  const claimQuestionId = (id: string, file: string) => {
    const prev = questionOwner.get(id);
    if (prev) problems.push(`${file}: question id "${id}" is already used in ${prev}`);
    questionOwner.set(id, file);
  };

  // --- certs and their question banks
  const certs = new Map<string, Cert>();
  const certQuestions = new Map<string, Question[]>();
  /** Bank questions that name a unit; checked once units are loaded. */
  const unitLinks: { where: string; unitId: string }[] = [];
  /** Bank questions whose cert domains are checked once every cert is loaded. */
  const bankChecks: { where: string; q: Question }[] = [];

  for (const dir of listDirs(path.join(contentDir, "certs"))) {
    const certDir = path.join(contentDir, "certs", dir);
    const file = path.join(certDir, "cert.json");
    const cert = readJson(file, CertSchema);
    if (!cert) continue;
    if (cert.id !== dir) problems.push(`${rel(file)}: id "${cert.id}" must match directory "${dir}"`);
    certs.set(cert.id, cert);

    const bank: Question[] = [];
    const bankDir = path.join(certDir, "questions");
    const bankFiles = fs.existsSync(bankDir)
      ? fs.readdirSync(bankDir).filter((f) => f.endsWith(".json")).sort()
      : [];
    for (const f of bankFiles) {
      const bankFile = path.join(bankDir, f);
      for (const q of readJson(bankFile, QuizFileSchema)?.questions ?? []) {
        const where = `${rel(bankFile)}: question "${q.id}"`;
        claimQuestionId(q.id, rel(bankFile));
        const own = q.certs.filter((c) => c.id === cert.id);
        if (own.length === 0) problems.push(`${where} must list cert "${cert.id}" in "certs"`);
        if (q.provider !== "general" && q.provider !== cert.provider) {
          problems.push(`${where} uses provider "${q.provider}" but the cert is for "${cert.provider}"`);
        }
        if (q.unitId) unitLinks.push({ where, unitId: q.unitId });
        bankChecks.push({ where, q });
        bank.push(q);
      }
    }
    certQuestions.set(cert.id, bank);
  }

  // --- units
  const units = new Map<string, Unit>();
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
      claimQuestionId(q.id, rel(quizFile));
      if (q.unitId !== meta.id) {
        problems.push(`${rel(quizFile)}: question "${q.id}" must have unitId "${meta.id}"`);
      }
      if (!providerAllowed(q.provider)) {
        problems.push(`${rel(quizFile)}: question "${q.id}" uses provider "${q.provider}" not declared by the unit`);
      }
      for (const c of q.certs) {
        checkCertDomain(`${rel(quizFile)}: question "${q.id}"`, c.id, c.domain);
        certQuestions.get(c.id)?.push(q);
      }
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

    // flows/*.json
    const flows: Flow[] = [];
    const flowsDir = path.join(unitDir, "flows");
    const flowFiles = fs.existsSync(flowsDir)
      ? fs.readdirSync(flowsDir).filter((f) => f.endsWith(".json")).sort()
      : [];
    for (const f of flowFiles) {
      const flowFile = path.join(flowsDir, f);
      const flow = readJson(flowFile, FlowSchema);
      if (!flow) continue;
      const where = rel(flowFile);
      if (`${flow.id}.json` !== f) problems.push(`${where}: id "${flow.id}" must match file name`);
      const ids = new Set<string>();
      const cells = new Set<string>();
      for (const n of flow.nodes) {
        if (ids.has(n.id)) problems.push(`${where}: node id "${n.id}" is used twice`);
        ids.add(n.id);
        const cell = `${n.col},${n.row}`;
        if (cells.has(cell)) problems.push(`${where}: node "${n.id}" shares col ${n.col}, row ${n.row} with another node`);
        cells.add(cell);
      }
      flow.steps.forEach((step, i) => {
        for (const id of [step.from, step.to]) {
          if (id !== undefined && !ids.has(id)) problems.push(`${where}: step ${i + 1} refers to unknown node "${id}"`);
        }
        if (step.from === step.to) problems.push(`${where}: step ${i + 1} goes from "${step.from}" to itself; leave out "to" instead`);
      });
      if (!new RegExp(`<Flow\\s+id="${flow.id}"`).test(lesson)) problems.push(`${where}: flow "${flow.id}" is not used in lesson.mdx`);
      flows.push(flow);
    }
    for (const m of lesson.matchAll(/<Flow\s+id="([^"]*)"/g)) {
      if (!flows.some((f) => f.id === m[1])) problems.push(`${rel(lessonFile)}: <Flow id="${m[1]}"> has no flows/${m[1]}.json`);
    }

    for (const ref of meta.certDomains) {
      const [certId, domain] = ref.split(":");
      checkCertDomain(`${rel(metaFile)}: certDomains "${ref}"`, certId, Number(domain));
    }

    units.set(meta.id, { meta, lesson, quiz, labs, flows });
  }

  /** Domain numbers can only be checked once that cert's cert.json exists. */
  function checkCertDomain(where: string, certId: string, domain: number) {
    const cert = certs.get(certId);
    if (cert && !cert.domains.some((d) => d.id === domain)) {
      problems.push(`${where}: cert "${certId}" has no domain ${domain}`);
    }
  }

  for (const { where, q } of bankChecks) {
    for (const c of q.certs) checkCertDomain(where, c.id, c.domain);
  }
  for (const link of unitLinks) {
    if (!units.has(link.unitId)) problems.push(`${link.where} names unknown unit "${link.unitId}"`);
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

  // --- challenges/*.json
  const challenges: Challenge[] = [];
  const challengeDir = path.join(contentDir, "challenges");
  const challengeFiles = fs.existsSync(challengeDir)
    ? fs.readdirSync(challengeDir).filter((f) => f.endsWith(".json")).sort()
    : [];
  for (const f of challengeFiles) {
    const file = path.join(challengeDir, f);
    const challenge = readJson(file, ChallengeSchema);
    if (!challenge) continue;
    if (`${challenge.id}.json` !== f) problems.push(`${rel(file)}: id "${challenge.id}" must match the file name`);
    if (!units.has(challenge.unitId)) problems.push(`${rel(file)}: unknown unit "${challenge.unitId}"`);
    challenges.push(challenge);
  }
  const trackOrder = ["basics", "aws", "gcp"];
  challenges.sort((a, b) => trackOrder.indexOf(a.track) - trackOrder.indexOf(b.track) || a.level - b.level);
  for (const track of trackOrder) {
    const levels = challenges.filter((c) => c.track === track).map((c) => c.level);
    if (levels.some((level, i) => level !== i + 1)) {
      problems.push(`challenges: track "${track}" levels must be 1, 2, 3… without gaps (found ${levels.join(", ")})`);
    }
  }

  if (problems.length) throw new ContentError(problems);
  return { stages, units, certs, certQuestions, challenges };
}

let cached: Content | undefined;

/** Content for pages. Memoised in production; re-read on every call in dev. */
export function getContent(): Content {
  if (process.env.NODE_ENV !== "production") return loadContent();
  return (cached ??= loadContent());
}
