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

const DOCKERFILE = "FROM public.ecr.aws/amazonlinux/amazonlinux:latest\nRUN yum update -y && \\\n    yum install -y httpd\nCOPY index.html /var/www/html/index.html\nEXPOSE 80\nCMD /usr/sbin/httpd -D FOREGROUND\n";
const APP = { files: { "~/app/Dockerfile": DOCKERFILE, "~/app/index.html": "<h1>hi</h1>\n" } };
const REG = "123456789012.dkr.ecr.us-east-1.amazonaws.com";
const LOGIN = `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${REG}`;
const AR = "asia-east1-docker.pkg.dev/my-project/lab-repo/hello-web";
const built = (seed: object = APP) => sh(createLabState(seed), "cd app", "docker build -t hello-web .").state;

describe("docker build and run", () => {
  it("builds from a Dockerfile in the build context", () => {
    const r = sh(createLabState(APP), "cd app", "docker build -t hello-web .");
    expect(r.text).toContain("[1/3] FROM public.ecr.aws/amazonlinux/amazonlinux:latest");
    expect(r.text).toContain("[2/3] RUN yum update -y && yum install -y httpd");
    expect(view(r.state).docker.images["hello-web:latest"]).toMatchObject({ base: "public.ecr.aws/amazonlinux/amazonlinux:latest", exposed: [80] });
    expect(sh(r.state, "docker images").text).toMatch(/hello-web\s+latest/);
  });

  it("reports Dockerfile problems", () => {
    expect(sh(createLabState(APP), "docker build -t x .").error).toContain("failed to read dockerfile");
    expect(sh(createLabState({ files: { "~/Dockerfile": "RUN echo hi\n" } }), "docker build -t x .").error).toContain("FROM");
    expect(sh(createLabState({ files: { "~/Dockerfile": "FROM a\nCOPY missing.txt /x\n" } }), "docker build -t x .").error).toContain("not found");
    expect(sh(createLabState({ files: { "~/Dockerfile": "FROM a\nINSTALL x\n" } }), "docker build -t x .").error).toContain("unknown instruction");
    expect(sh(createLabState(APP), "cd app", "docker build -t x").error).toContain("requires exactly 1 argument");
  });

  it("runs containers with published ports and serves them on localhost", () => {
    const s = sh(built(), "docker run -d -p 8080:80 --name web hello-web").state;
    expect(sh(s, "curl http://localhost:8080").text).toBe("<h1>hi</h1>");
    expect(sh(s, "curl localhost:9090").error).toContain("Connection refused");
    expect(sh(s, "docker run -d -p 8080:80 --name web2 hello-web").error).toContain("port is already allocated");
    expect(sh(s, "docker run -d -p 9090:8080 --name wrong hello-web", "curl http://localhost:9090").error).toContain("80");
    expect(sh(s, "docker rm web").error).toContain("container is running");
    const removed = sh(s, "docker stop web", "docker rm web").state;
    expect(view(removed).docker.containers).toEqual({});
  });
});

describe("pipes", () => {
  it("feeds get-login-password into docker login", () => {
    const r = sh(createLabState(), LOGIN);
    expect(r.text).toBe("Login Succeeded");
    expect(view(r.state).docker.logins).toEqual({ [REG]: true });
    expect(sh(createLabState(), `echo wrong | docker login --username AWS --password-stdin ${REG}`).error).toContain("no basic auth credentials");
  });
});

describe("aws ecr", () => {
  const push = `docker push ${REG}/hello-web:v1`;
  const tag = `docker tag hello-web:latest ${REG}/hello-web:v1`;

  it("needs a login, a repository and the registry name", () => {
    const s = sh(built(), tag).state;
    expect(sh(s, push).error).toContain("no basic auth credentials");
    expect(sh(s, LOGIN, push).error).toContain("does not exist");
    expect(sh(s, "docker push hello-web:latest").error).toContain("Amazon ECR");
    const ok = sh(s, LOGIN, "aws ecr create-repository --repository-name hello-web", push);
    expect(ok.text).toContain("v1: digest: sha256:");
    expect(Object.keys(view(ok.state).cloud.aws.ecr.repositories["hello-web"].images)).toEqual(["v1"]);
    expect(JSON.parse(sh(ok.state, "aws ecr describe-images --repository-name hello-web").text).imageDetails[0].imageTags).toEqual(["v1"]);
  });

  it("immutable repositories refuse to overwrite a tag", () => {
    let s = sh(built(), "aws ecr create-repository --repository-name hello-web --image-tag-mutability IMMUTABLE", LOGIN, tag, push).state;
    s = sh(s, "echo '<h1>v2</h1>' > index.html", "docker build -t hello-web .", tag).state;
    expect(sh(s, push).error).toContain("immutable");
    expect(sh(s, `docker tag hello-web:latest ${REG}/hello-web:v2`, `docker push ${REG}/hello-web:v2`).errors).toEqual([]);
  });

  it("deleting a repository with images needs --force", () => {
    const s = sh(built(), "aws ecr create-repository --repository-name hello-web", LOGIN, tag, push).state;
    expect(sh(s, "aws ecr delete-repository --repository-name hello-web").error).toContain("RepositoryNotEmptyException");
    expect(sh(s, "aws ecr delete-repository --repository-name hello-web --force").errors).toEqual([]);
  });
});

describe("aws ecs", () => {
  const def = (over: object = {}) =>
    `'${JSON.stringify({
      family: "hello-web",
      requiresCompatibilities: ["FARGATE"],
      networkMode: "awsvpc",
      cpu: "256",
      memory: "512",
      executionRoleArn: "arn:aws:iam::123456789012:role/ecsTaskExecutionRole",
      containerDefinitions: [{ name: "web", image: `${REG}/hello-web:v1`, portMappings: [{ containerPort: 80 }] }],
      ...over,
    })}'`;
  const SEED = { ...APP, cloud: { aws: { vpcs: { "vpc-1": { cidr: "10.0.0.0/16", subnets: { "subnet-a": { cidr: "10.0.1.0/24", availabilityZone: "us-east-1a" } } } } } } };
  const SERVICE = "aws ecs create-service --cluster lab --service-name svc --task-definition hello-web:1 --desired-count 2 --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[subnet-a],securityGroups=[sg-1],assignPublicIp=ENABLED}'";

  it("validates Fargate task sizes and network mode", () => {
    const s = createLabState();
    expect(sh(s, `aws ecs register-task-definition --cli-input-json ${def({ memory: "4096" })}`).error).toContain("No Fargate configuration");
    expect(sh(s, `aws ecs register-task-definition --cli-input-json ${def({ networkMode: "bridge" })}`).error).toContain("awsvpc");
    const r = sh(s, `aws ecs register-task-definition --cli-input-json ${def()}`, `aws ecs register-task-definition --cli-input-json ${def({ memory: "1024" })}`);
    expect(Object.keys(view(r.state).cloud.aws.ecs.taskDefinitions)).toEqual(["hello-web:1", "hello-web:2"]);
  });

  it("runs the service only after the image is in ECR", () => {
    let s = sh(createLabState(SEED), "aws ecs create-cluster --cluster-name lab", `aws ecs register-task-definition --cli-input-json ${def()}`, SERVICE).state;
    expect(view(s).cloud.aws.ecs.services["lab/svc"].runningCount).toBe(0);
    expect(sh(s, "aws ecs describe-services --cluster lab --services svc").text).toContain("CannotPullContainerError");
    s = sh(s, "cd app", "docker build -t hello-web .", "aws ecr create-repository --repository-name hello-web", LOGIN, `docker tag hello-web ${REG}/hello-web:v1`, `docker push ${REG}/hello-web:v1`).state;
    expect(view(s).cloud.aws.ecs.services["lab/svc"]).toEqual({ taskDefinition: "hello-web:1", desiredCount: 2, runningCount: 2, launchType: "FARGATE" });
    const scaled = sh(s, "aws ecs update-service --cluster lab --service svc --desired-count 3");
    expect(JSON.parse(sh(scaled.state, "aws ecs list-tasks --cluster lab").text).taskArns).toHaveLength(3);
  });

  it("checks subnets and the cluster", () => {
    const s = sh(createLabState(SEED), `aws ecs register-task-definition --cli-input-json ${def()}`).state;
    expect(sh(s, SERVICE).error).toContain("ClusterNotFoundException");
    expect(sh(s, "aws ecs create-cluster --cluster-name lab", SERVICE.replace("subnet-a", "subnet-zz")).error).toContain("subnet-zz");
  });
});

describe("artifact registry and cloud run", () => {
  const PUSH = ["gcloud artifacts repositories create lab-repo --repository-format=docker --location=asia-east1", "gcloud auth configure-docker asia-east1-docker.pkg.dev", `docker tag hello-web ${AR}:v1`, `docker push ${AR}:v1`];

  it("pushes after configure-docker and lists images", () => {
    const s = built();
    expect(sh(s, PUSH[0], `docker tag hello-web ${AR}:v1`, `docker push ${AR}:v1`).error).toContain("configure-docker");
    const r = sh(s, ...PUSH);
    expect(r.errors).toEqual([]);
    expect(view(r.state).cloud.gcp.artifacts.repositories["asia-east1/lab-repo"].images).toHaveProperty(["hello-web:v1"]);
    expect(sh(r.state, "gcloud artifacts docker images list asia-east1-docker.pkg.dev/my-project/lab-repo").text).toContain(`${AR}`);
    expect(sh(s, "gcloud auth configure-docker asia-east1-docker.pkg.dev", `docker tag hello-web ${AR}:v1`, `docker push ${AR}:v1`).error).toContain("not found");
  });

  it("immutable tags in Artifact Registry", () => {
    let s = sh(built(), "gcloud artifacts repositories create lab-repo --repository-format=docker --location=asia-east1 --immutable-tags", ...PUSH.slice(1)).state;
    s = sh(s, "echo changed > index.html", "docker build -t hello-web .", `docker tag hello-web ${AR}:v1`).state;
    expect(sh(s, `docker push ${AR}:v1`).error).toContain("不可變");
  });

  it("Cloud Run needs a pushed image and the right port", () => {
    const deploy = `gcloud run deploy hello-web --image=${AR}:v1 --region=asia-east1 --allow-unauthenticated`;
    expect(sh(built(), deploy).error).toContain("not found");
    const s = sh(built(), ...PUSH).state;
    expect(sh(s, deploy).error).toContain("PORT=8080");
    const r = sh(s, `${deploy} --port=80`);
    expect(r.errors).toEqual([]);
    expect(view(r.state).cloud.gcp.run.services["hello-web"].image).toBe(`${AR}:v1`);
  });
});

describe("container labs can be completed", () => {
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

  it("aws-ecr-ecs", () => {
    expect(
      play("aws-ecr-ecs", [
        ["cd app", "cat Dockerfile", "docker build -t hello-web .", "docker images"],
        ["docker run -d -p 8080:80 --name web hello-web", "curl http://localhost:8080"],
        ["aws ecr create-repository --repository-name hello-web --image-tag-mutability IMMUTABLE"],
        [`docker tag hello-web:latest ${REG}/hello-web:v1`, `docker push ${REG}/hello-web:v1`, LOGIN, `docker push ${REG}/hello-web:v1`],
        ["aws ecs create-cluster --cluster-name lab-cluster", "cd ~", "cat taskdef.json", "aws ecs register-task-definition --cli-input-json file://taskdef.json"],
        [
          "aws ec2 describe-subnets",
          "aws ecs create-service --cluster lab-cluster --service-name hello-svc --task-definition hello-web:1 --desired-count 2 --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[subnet-0a1b2c3d4e5f60718,subnet-0b2c3d4e5f6071829],securityGroups=[sg-0123456789abcdef0],assignPublicIp=ENABLED}'",
          "aws ecs describe-services --cluster lab-cluster --services hello-svc",
        ],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gcp-artifact-registry-run", () => {
    expect(
      play("gcp-artifact-registry-run", [
        ["cd app", "docker build -t hello-web .", "docker run -d -p 8080:80 --name web hello-web", "curl http://localhost:8080"],
        ['gcloud artifacts repositories create lab-repo --repository-format=docker --location=asia-east1 --description="Docker repository"'],
        ["gcloud auth configure-docker asia-east1-docker.pkg.dev", `docker tag hello-web:latest ${AR}:v1`, `docker push ${AR}:v1`, "gcloud artifacts docker images list asia-east1-docker.pkg.dev/my-project/lab-repo"],
        [`gcloud run deploy hello-web --image=${AR}:v1 --region=asia-east1 --allow-unauthenticated`, `gcloud run deploy hello-web --image=${AR}:v1 --region=asia-east1 --allow-unauthenticated --port=80`],
      ]),
    ).toEqual([1, 2, 3, 4]);
  });
});
