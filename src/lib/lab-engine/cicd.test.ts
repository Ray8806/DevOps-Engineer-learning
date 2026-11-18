import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { advance } from "./check";
import { execute } from "./engine";
import { checkView, createLabState, type LabState } from "./state";

function sh(state: LabState, ...lines: string[]) {
  let out: string[] = [];
  let errors: string[] = [];
  for (const line of lines) {
    const result = execute(state, line);
    state = result.state;
    out = result.lines.filter((l) => !l.error).map((l) => l.text);
    errors = result.lines.filter((l) => l.error).map((l) => l.text);
  }
  return { state, out, errors, text: out.join("\n"), error: errors.join("\n") };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the check view is walked loosely in tests */
const view = (state: LabState): any => checkView(state);

const DOCKERFILE = "FROM nginx:latest\nCOPY index.html /usr/share/nginx/html/index.html\nEXPOSE 80\n";
const BUILDSPEC = `version: 0.2
env:
  variables:
    IMAGE_REPO_NAME: web
    IMAGE_TAG: v1
phases:
  pre_build:
    commands:
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
  build:
    commands:
      - echo Build started on \`date\`
      - docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .
      - docker tag $IMAGE_REPO_NAME:$IMAGE_TAG \${AWS_ACCOUNT_ID}.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG
  post_build:
    commands:
      - docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG
`;
const PROJECT = {
  name: "web-build",
  source: { type: "S3", location: "src-bucket/app.zip" },
  artifacts: { type: "NO_ARTIFACTS" },
  environment: {
    type: "LINUX_CONTAINER",
    image: "aws/codebuild/standard:5.0",
    computeType: "BUILD_GENERAL1_SMALL",
    environmentVariables: [{ name: "AWS_ACCOUNT_ID", value: "123456789012" }],
  },
  serviceRole: "arn:aws:iam::123456789012:role/cb",
};

const awsLab = () =>
  createLabState({
    files: { "~/app/Dockerfile": DOCKERFILE, "~/app/index.html": "hi", "~/app/buildspec.yml": BUILDSPEC, "~/project.json": JSON.stringify(PROJECT) },
    cloud: { s3: { buckets: { "src-bucket": {} } } },
  });
const uploaded = () =>
  sh(awsLab(), "cd app", "zip -r ../app.zip .", "aws s3 cp ../app.zip s3://src-bucket/app.zip", "cd ~", "aws ecr create-repository --repository-name web", "aws codebuild create-project --cli-input-json file://project.json").state;
const buildId = (text: string) => JSON.parse(text.slice(0, text.lastIndexOf("}") + 1)).build.id as string;

describe("aws codebuild", () => {
  it("creates projects from JSON and validates the input", () => {
    const s = uploaded();
    expect(view(s).cloud.aws.codebuild.projects["web-build"]).toEqual({ source: "src-bucket/app.zip", image: "aws/codebuild/standard:5.0", privilegedMode: false, lastBuild: null, failedBuilds: 0 });
    expect(sh(s, "aws codebuild create-project --cli-input-json file://project.json").error).toContain("ResourceAlreadyExistsException");
    expect(sh(s, "aws codebuild create-project --cli-input-json file://missing.json").error).toContain("Unable to load paramfile");
    expect(sh(s, "aws codebuild list-projects").text).toContain('"web-build"');
    expect(sh(s, `aws codebuild create-project --cli-input-json '${JSON.stringify({ ...PROJECT, name: "x2", serviceRole: "cb" })}'`).error).toContain("serviceRole");
  });

  it("fails docker commands without privileged mode and logs the reason", () => {
    let r = sh(uploaded(), "aws codebuild start-build --project-name web-build");
    const id = buildId(r.text);
    expect(id).toMatch(/^web-build:[0-9a-f]{8}-/);
    r = sh(r.state, `aws codebuild batch-get-builds --ids ${id}`);
    const build = JSON.parse(r.text).builds[0];
    expect(build.buildStatus).toBe("FAILED");
    // docker login works without the daemon; docker build does not.
    expect(build.phases.map((p: any) => `${p.phaseType}:${p.phaseStatus}`)).toEqual(["DOWNLOAD_SOURCE:SUCCEEDED", "PRE_BUILD:SUCCEEDED", "BUILD:FAILED"]);
    expect(build.logs.groupName).toBe("/aws/codebuild/web-build");
    r = sh(r.state, "aws logs filter-log-events --log-group-name /aws/codebuild/web-build");
    expect(r.text).toContain("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
    expect(r.text).toContain("Build started on Mon Nov 16");
    expect(view(r.state).cloud.aws.codebuild.projects["web-build"]).toMatchObject({ lastBuild: "FAILED", failedBuilds: 1 });
    // The build's workspace does not leak into the learner's files.
    expect([...r.state.files.keys()].some((p) => p.startsWith("/codebuild"))).toBe(false);
  });

  it("builds and pushes to ECR in privileged mode without touching local docker", () => {
    let r = sh(uploaded(), "aws codebuild update-project --name web-build --environment type=LINUX_CONTAINER,image=aws/codebuild/standard:5.0,computeType=BUILD_GENERAL1_SMALL,privilegedMode=true");
    expect(view(r.state).cloud.aws.codebuild.projects["web-build"].privilegedMode).toBe(true);
    r = sh(r.state, "aws codebuild start-build --project-name web-build");
    const id = buildId(r.text);
    expect(view(r.state).cloud.aws.codebuild.builds[id]).toEqual({ project: "web-build", status: "SUCCEEDED", phases: { DOWNLOAD_SOURCE: "SUCCEEDED", PRE_BUILD: "SUCCEEDED", BUILD: "SUCCEEDED", POST_BUILD: "SUCCEEDED" } });
    expect(view(r.state).cloud.aws.ecr.repositories.web.images).toHaveProperty(["v1"]);
    expect(r.state.docker.images.size).toBe(0);
    expect(r.state.docker.logins.size).toBe(0);
    expect(sh(r.state, "aws codebuild list-builds-for-project --project-name web-build").text).toContain(id);
  });

  it("reports missing or broken sources", () => {
    let s = sh(awsLab(), "aws codebuild create-project --cli-input-json file://project.json").state;
    let r = sh(s, "aws codebuild start-build --project-name web-build");
    r = sh(r.state, `aws codebuild batch-get-builds --ids ${buildId(r.text)}`);
    expect(JSON.parse(r.text).builds[0].phases).toEqual([{ phaseType: "DOWNLOAD_SOURCE", phaseStatus: "FAILED" }]);
    s = sh(s, "cd app", "rm buildspec.yml", "zip -r ../app.zip .", "aws s3 cp ../app.zip s3://src-bucket/app.zip", "cd ~").state;
    r = sh(s, "aws codebuild start-build --project-name web-build");
    expect(view(r.state).cloud.aws.codebuild.projects["web-build"].lastBuild).toBe("FAILED");
    expect(sh(r.state, "aws logs filter-log-events --log-group-name /aws/codebuild/web-build").text).toContain("YAML_FILE_ERROR");
    expect(sh(s, "aws codebuild start-build --project-name nope").error).toContain("ResourceNotFoundException");
  });
});

const CLOUDBUILD = `substitutions:
  _SERVICE: web
steps:
- name: 'gcr.io/cloud-builders/docker'
  args: ['build', '-t', 'asia-east1-docker.pkg.dev/$PROJECT_ID/repo/web:$BUILD_ID', '.']
- name: 'gcr.io/cloud-builders/docker'
  args: ['push', 'asia-east1-docker.pkg.dev/$PROJECT_ID/repo/web:$BUILD_ID']
- name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
  entrypoint: gcloud
  args: ['run', 'deploy', '\${_SERVICE}', '--image', 'asia-east1-docker.pkg.dev/$PROJECT_ID/repo/web:$BUILD_ID', '--region', 'asia-east1', '--port', '80']
`;
const gcpLab = (config = CLOUDBUILD) => createLabState({ files: { "~/app/Dockerfile": DOCKERFILE, "~/app/index.html": "hi", "~/app/cloudbuild.yaml": config } });

describe("gcloud builds", () => {
  it("fails at the push step when the repository is missing, and shows the log", () => {
    const r = sh(gcpLab(), "cd app", "gcloud builds submit --config=cloudbuild.yaml .");
    expect(r.error).toMatch(/completed with status "FAILURE"/);
    const v = view(r.state).cloud.gcp.cloudbuild;
    expect(v.lastBuild).toBe("FAILURE");
    const [id] = Object.keys(v.builds);
    expect(v.builds[id].steps).toEqual(["SUCCESS", "FAILURE", "QUEUED"]);
    expect(sh(r.state, "gcloud builds list").text).toContain(`${id}  FAILURE`);
    const log = sh(r.state, `gcloud builds log ${id}`).text;
    expect(log).toContain('Step #1: name unknown: Repository "repo" not found');
    expect(log).toContain(`asia-east1-docker.pkg.dev/my-project/repo/web:${id}`);
    expect(r.state.docker.images.size).toBe(0);
  });

  it("deploys to Cloud Run and supports substitutions", () => {
    let r = sh(gcpLab(), "cd app", "gcloud artifacts repositories create repo --repository-format=docker --location=asia-east1", "gcloud builds submit --config=cloudbuild.yaml --region=asia-east1 .");
    expect(r.text).toMatch(/SUCCESS/);
    expect(view(r.state).cloud.gcp.run.services).toHaveProperty(["web"]);
    r = sh(r.state, "gcloud builds submit --config=cloudbuild.yaml --substitutions=_SERVICE=web-staging .");
    expect(view(r.state).cloud.gcp.run.services).toHaveProperty(["web-staging"]);
    expect(Object.keys(view(r.state).cloud.gcp.artifacts.repositories["asia-east1/repo"].images)).toHaveLength(2);
    expect(sh(r.state, "gcloud builds submit --substitutions=service=x .").error).toContain("invalid substitution key");
    expect(sh(r.state, "gcloud builds submit --substitutions=PROJECT_ID=x .").error).toContain("PROJECT_ID");
  });

  it("validates the config", () => {
    expect(sh(gcpLab(), "gcloud builds submit app").error).toContain("Unable to read file [cloudbuild.yaml]");
    expect(sh(gcpLab(), "cd app", "gcloud builds submit --config=nope.yaml .").error).toContain("nope.yaml");
    expect(sh(gcpLab("steps: []\n"), "cd app", "gcloud builds submit .").error).toContain("at least one step");
    expect(sh(gcpLab(CLOUDBUILD.replace("substitutions:\n  _SERVICE: web\n", "")), "cd app", "gcloud builds submit .").error).toContain('"_SERVICE" is not matched');
    expect(sh(gcpLab(), "gcloud builds log nope").error).toContain("NOT_FOUND");
  });
});

describe("ci/cd labs can be completed", () => {
  const labs = new Map([...loadContent().units.values()].flatMap((u) => u.labs).map((l) => [l.id, l]));
  function play(labId: string, groups: string[][]): number[] {
    const lab = labs.get(labId)!;
    let state = createLabState(lab.initialState);
    let done = advance(0, state, lab.steps);
    return groups.map((commands) => {
      for (const c of commands) {
        state = execute(state, c).state;
        done = advance(done, state, lab.steps);
      }
      return done;
    });
  }

  it("aws-codebuild-docker", () => {
    const id = "hello-web-build:9e3779b1-0000-4000-8000-000000000001";
    expect(
      play("aws-codebuild-docker", [
        ["cd app", "cat buildspec.yml", "zip -r ../app.zip .", "aws s3 cp ../app.zip s3://lab-build-input-123456789012/app.zip"],
        ["aws ecr create-repository --repository-name hello-web", "cd ~", "cat project.json", "aws codebuild create-project --cli-input-json file://project.json"],
        ["aws codebuild start-build --project-name hello-web-build", `aws codebuild batch-get-builds --ids ${id}`, "aws logs filter-log-events --log-group-name /aws/codebuild/hello-web-build"],
        [
          "aws codebuild update-project --name hello-web-build --environment type=LINUX_CONTAINER,image=aws/codebuild/standard:5.0,computeType=BUILD_GENERAL1_SMALL,privilegedMode=true",
          "aws codebuild start-build --project-name hello-web-build",
          "aws ecr describe-images --repository-name hello-web",
        ],
      ]),
    ).toEqual([1, 2, 3, 4]);
  });

  it("gcp-cloud-build-run", () => {
    expect(
      play("gcp-cloud-build-run", [
        ["cd app", "cat cloudbuild.yaml", "gcloud builds submit --config=cloudbuild.yaml --region=asia-east1 ."],
        ["gcloud builds list", "gcloud artifacts repositories create web-repo --repository-format=docker --location=asia-east1", "gcloud builds submit --config=cloudbuild.yaml --region=asia-east1 ."],
        ["gcloud builds submit --config=cloudbuild.yaml --region=asia-east1 --substitutions=_SERVICE=hello-web-staging .", "gcloud run services list"],
      ]),
    ).toEqual([1, 2, 3]);
  });
});
