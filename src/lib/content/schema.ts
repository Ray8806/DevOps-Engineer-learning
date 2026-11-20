import { z } from "zod";

/** Slug used for unit, question and lab ids (also directory / file names). */
const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be lowercase kebab-case");

export const PROVIDERS = ["aws", "gcp"] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;

/** Content that is not tied to one cloud (Linux, networking, general concepts). */
export const ContentProviderSchema = z.enum([...PROVIDERS, "general"]);
export type ContentProvider = z.infer<typeof ContentProviderSchema>;

export const CERT_IDS = ["clf-c02", "saa-c03", "gcp-cdl", "gcp-ace"] as const;
export const CertIdSchema = z.enum(CERT_IDS);
export type CertId = z.infer<typeof CertIdSchema>;

// ---------------------------------------------------------------- stages.json

export const StageSchema = z.strictObject({
  id: z.number().int().min(0),
  title: z.string().min(1),
  description: z.string().min(1),
  /** Unit ids in learning order. */
  units: z.array(slug),
});
export type Stage = z.infer<typeof StageSchema>;

export const StagesFileSchema = z.strictObject({
  stages: z.array(StageSchema).min(1),
});

// ------------------------------------------------------------------ unit.json

const ProviderInfoSchema = z.strictObject({
  services: z.array(z.string().min(1)).min(1),
});

/** "<cert-id>:<domain number>", e.g. "saa-c03:3". */
const CertDomainRefSchema = z
  .string()
  .regex(/^[a-z0-9-]+:[1-9][0-9]*$/, 'must look like "saa-c03:3"')
  .refine(
    (ref) => (CERT_IDS as readonly string[]).includes(ref.split(":")[0]),
    `cert id must be one of: ${CERT_IDS.join(", ")}`,
  );

export const UnitMetaSchema = z.strictObject({
  id: slug,
  title: z.string().min(1),
  summary: z.string().min(1),
  stage: z.number().int().min(0),
  prerequisites: z.array(slug).default([]),
  /** Empty object = provider-neutral unit (e.g. Linux basics). */
  providers: z.strictObject({
    aws: ProviderInfoSchema.optional(),
    gcp: ProviderInfoSchema.optional(),
  }),
  /** Rows rendered by <Compare /> in the lesson. */
  compare: z
    .array(
      z.strictObject({
        aspect: z.string().min(1),
        aws: z.string().min(1),
        gcp: z.string().min(1),
      }),
    )
    .default([]),
  certDomains: z.array(CertDomainRefSchema).default([]),
  estimatedMinutes: z.number().int().positive(),
});
export type UnitMeta = z.infer<typeof UnitMetaSchema>;

// ------------------------------------------- questions (quiz.json + cert banks)

const OptionSchema = z.strictObject({
  id: z.string().regex(/^[a-z]$/, "must be a single lowercase letter"),
  text: z.string().min(1),
  /** Why this option is right or wrong. Required for every option. */
  explanation: z.string().min(1),
});

export const QuestionSchema = z
  .strictObject({
    id: slug,
    type: z.enum(["single", "multiple"]),
    provider: ContentProviderSchema,
    certs: z
      .array(
        z.strictObject({
          id: CertIdSchema,
          domain: z.number().int().positive(),
        }),
      )
      .default([]),
    unitId: slug.optional(),
    difficulty: z.number().int().min(1).max(3),
    question: z.string().min(1),
    options: z.array(OptionSchema).min(2),
    answer: z.array(z.string()).min(1),
  })
  .superRefine((q, ctx) => {
    const ids = q.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "option ids must be unique" });
    }
    if (new Set(q.answer).size !== q.answer.length) {
      ctx.addIssue({ code: "custom", path: ["answer"], message: "answer ids must be unique" });
    }
    for (const a of q.answer) {
      if (!ids.includes(a)) {
        ctx.addIssue({ code: "custom", path: ["answer"], message: `answer "${a}" is not an option id` });
      }
    }
    if (q.type === "single" && q.answer.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["answer"], message: "single-choice questions need exactly one answer" });
    }
    if (q.type === "multiple" && q.answer.length < 2) {
      ctx.addIssue({ code: "custom", path: ["answer"], message: "multiple-choice questions need at least two answers" });
    }
  });
export type Question = z.infer<typeof QuestionSchema>;

export const QuizFileSchema = z.strictObject({
  questions: z.array(QuestionSchema).min(1),
});

// ------------------------------------------------------------- labs/<id>.json

/**
 * A step passes when the lab's virtual state satisfies the check.
 * `path` is a list of keys (a list, not a dot string, because names such as
 * "report.txt" contain dots) into the lab engine's check view:
 *   ["files", "~/a.txt"]            file content
 *   ["dirs", "~/projects"]          directory exists
 *   ["cwd"]                         current directory, e.g. "~/projects"
 *   ["cloud", "s3", "buckets", name, "region" | "storageClass" | "objects", key]
 *   ["cloud", "gcs", "buckets", name, "location" | "storageClass" | "objects", name]
 *   ["git", "~/project", "branch" | "commitCount" | "lastMessage" | "clean"]
 *   ["git", "~/project", "branches" | "staged", name]
 *   ["git", "~/project", "branchFiles", branch, path]
 *   ["docker", "images" | "containers" | "logins", name]
 * Set exactly one of `exists` / `equals`. Steps are completed in order and
 * stay completed.
 */
const StateCheckSchema = z
  .strictObject({
    type: z.literal("state"),
    path: z.array(z.string().min(1)).min(1),
    exists: z.boolean().optional(),
    equals: z.json().optional(),
  })
  .refine(
    (c) => (c.exists === undefined) !== (c.equals === undefined),
    "set exactly one of `exists` or `equals`",
  )
  .refine((c) => ["files", "dirs", "cwd", "cloud", "git", "docker", "kube", "terraform"].includes(c.path[0]), {
    path: ["path"],
    message: 'path must start with "files", "dirs", "cwd", "cloud", "git", "docker", "kube" or "terraform"',
  });

/** Local paths in lab files are written from the home directory or the root. */
const labPath = z.string().regex(/^(~\/|\/)[^/]/, 'must start with "~/" or "/"');

export const LabSchema = z.strictObject({
  id: slug,
  title: z.string().min(1),
  description: z.string().min(1),
  provider: ContentProviderSchema,
  estimatedMinutes: z.number().int().positive(),
  initialState: z
    .strictObject({
      /** Virtual files: path -> content. */
      files: z.record(labPath, z.string()).default({}),
      /** Virtual cloud resources, shape owned by the lab engine. */
      cloud: z.record(z.string(), z.json()).default({}),
      /**
       * Commands run before the learner starts, to build an environment the
       * lab then asks them to inspect or fix. Each must succeed.
       */
      setup: z.array(z.string().min(1)).default([]),
    })
    .default({ files: {}, cloud: {}, setup: [] }),
  steps: z
    .array(
      z.strictObject({
        instruction: z.string().min(1),
        hint: z.string().min(1).optional(),
        check: StateCheckSchema,
      }),
    )
    .min(1),
});
export type Lab = z.infer<typeof LabSchema>;

// ------------------------------------------- units/<id>/flows/<flow-id>.json

/**
 * A step-by-step animated diagram shown in a lesson with <Flow id="…" />.
 * Nodes sit on a small grid (desktop: col across, row down; narrow screens
 * swap the two), and each step moves a token from one node to another or
 * highlights a single node.
 */
export const FLOW_MAX_COL = 4;
export const FLOW_MAX_ROW = 2;

export const FlowSchema = z.strictObject({
  id: slug,
  title: z.string().min(1),
  nodes: z
    .array(
      z.strictObject({
        id: slug,
        /** Short name shown in the box (keep it to about 8 full-width characters). */
        label: z.string().min(1).max(12),
        /** Optional smaller second line. */
        detail: z.string().min(1).max(20).optional(),
        col: z.number().int().min(0).max(FLOW_MAX_COL),
        row: z.number().int().min(0).max(FLOW_MAX_ROW),
      }),
    )
    .min(2),
  steps: z
    .array(
      z.strictObject({
        from: slug,
        /** Leave out to highlight `from` alone. */
        to: slug.optional(),
        text: z.string().min(1),
        /** "fail" draws the step in the danger color. */
        status: z.enum(["ok", "fail"]).default("ok"),
      }),
    )
    .min(2),
});
export type Flow = z.infer<typeof FlowSchema>;

// ------------------------------------------------------ certs/<id>/cert.json

/**
 * Exam facts. Every value must be copied from the official source named in
 * `source`, never from memory; leave an optional field out when the official
 * source does not state it.
 */
export const CertSchema = z
  .strictObject({
    id: CertIdSchema,
    /** Official certification name, in English. */
    name: z.string().min(1),
    summary: z.string().min(1),
    provider: ProviderSchema,
    level: z.enum(["foundational", "associate"]),
    source: z.strictObject({
      /** Official exam guide the domains and weights were copied from. */
      guideUrl: z.url(),
      /** Official page for registration and logistics. */
      officialPageUrl: z.url().optional(),
      /** Date the values were last checked against the official source. */
      verifiedOn: z.iso.date(),
      note: z.string().min(1).optional(),
    }),
    exam: z.strictObject({
      questionCountMin: z.number().int().positive(),
      questionCountMax: z.number().int().positive(),
      /** How many of the questions count towards the score, when stated. */
      scoredQuestions: z.number().int().positive().optional(),
      durationMinutes: z.number().int().positive().optional(),
      passingScore: z
        .strictObject({ score: z.number(), scaleMin: z.number(), scaleMax: z.number() })
        .optional(),
      questionTypes: z.array(z.enum(["single", "multiple"])).min(1),
    }),
    domains: z
      .array(
        z.strictObject({
          id: z.number().int().positive(),
          /** Official domain title, in English. */
          title: z.string().min(1),
          titleZh: z.string().min(1),
          weightPercent: z.number().positive().max(100),
        }),
      )
      .min(1),
  })
  .refine((c) => new Set(c.domains.map((d) => d.id)).size === c.domains.length, {
    path: ["domains"],
    message: "domain ids must be unique",
  })
  .refine((c) => c.domains.reduce((sum, d) => sum + d.weightPercent, 0) === 100, {
    path: ["domains"],
    message: "domain weights must add up to 100",
  })
  .refine((c) => c.exam.questionCountMin <= c.exam.questionCountMax, {
    path: ["exam"],
    message: "questionCountMin must not exceed questionCountMax",
  });
export type Cert = z.infer<typeof CertSchema>;

// -------------------------------------------------- challenges/<id>.json

/** Blanks are written as {{id}} in files and commands. */
export const BLANK_PATTERN = /\{\{([a-z][a-z0-9-]*)\}\}/g;

export const CHALLENGE_TRACKS = ["basics", "aws", "gcp"] as const;
export const ChallengeTrackSchema = z.enum(CHALLENGE_TRACKS);
export type ChallengeTrack = z.infer<typeof ChallengeTrackSchema>;

/**
 * A goal the finished environment must meet: a state check (same format as
 * lab steps), or a command whose output must (not) contain some text.
 */
const ChallengeGoalSchema = z.union([
  z.strictObject({ description: z.string().min(1), check: StateCheckSchema }),
  z.strictObject({
    description: z.string().min(1),
    run: z.string().min(1),
    contains: z.string().min(1).optional(),
    notContains: z.string().min(1).optional(),
  }),
]);

/**
 * A fill-in-the-blanks level: the learner picks a value for each blank, the
 * commands run in the lab engine, and the level is cleared when every
 * command succeeds and every goal holds. Each wrong choice must make the run
 * fail, which the tests check.
 */
export const ChallengeSchema = z
  .strictObject({
    id: slug,
    title: z.string().min(1),
    track: ChallengeTrackSchema,
    /** Position in the track, starting at 1; a level unlocks after the previous one. */
    level: z.number().int().positive(),
    provider: ContentProviderSchema,
    /** The unit that teaches this, linked from the level page. */
    unitId: slug,
    /** The situation, told to the learner. */
    story: z.string().min(1),
    objective: z.string().min(1),
    initialState: z
      .strictObject({
        files: z.record(labPath, z.string()).default({}),
        setup: z.array(z.string().min(1)).default([]),
      })
      .default({ files: {}, setup: [] }),
    /** Commands run in order after the blanks are filled; the run stops at the first failure. */
    commands: z.array(z.string().min(1)).min(1),
    blanks: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z][a-z0-9-]*$/),
          choices: z.array(z.string().min(1)).min(2).max(5),
          answer: z.string().min(1),
          /** Why the answer is right, shown after the level is cleared. */
          explain: z.string().min(1),
        }),
      )
      .min(1),
    goals: z.array(ChallengeGoalSchema).min(1),
    /** Shown after a failed run when the learner asks for a hint. */
    hint: z.string().min(1),
  })
  .superRefine((c, ctx) => {
    const used = new Set<string>();
    for (const text of [...Object.values(c.initialState.files), ...c.commands]) {
      for (const m of text.matchAll(BLANK_PATTERN)) used.add(m[1]);
    }
    const ids = new Set<string>();
    c.blanks.forEach((b, i) => {
      if (ids.has(b.id)) ctx.addIssue({ code: "custom", path: ["blanks", i, "id"], message: `duplicate blank "${b.id}"` });
      ids.add(b.id);
      if (!used.has(b.id)) ctx.addIssue({ code: "custom", path: ["blanks", i, "id"], message: `blank "${b.id}" is not used in files or commands` });
      if (!b.choices.includes(b.answer)) ctx.addIssue({ code: "custom", path: ["blanks", i, "answer"], message: "answer must be one of the choices" });
      if (new Set(b.choices).size !== b.choices.length) ctx.addIssue({ code: "custom", path: ["blanks", i, "choices"], message: "choices must be unique" });
    });
    for (const id of used) {
      if (!ids.has(id)) ctx.addIssue({ code: "custom", path: ["blanks"], message: `{{${id}}} has no blank definition` });
    }
    c.goals.forEach((g, i) => {
      if ("run" in g && !g.contains && !g.notContains) {
        ctx.addIssue({ code: "custom", path: ["goals", i], message: "set contains or notContains" });
      }
    });
  });
export type Challenge = z.infer<typeof ChallengeSchema>;
export type ChallengeGoal = z.infer<typeof ChallengeGoalSchema>;
