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
const gke = (s: LabState) => view(s).cloud.gcp.gke.clusters.hello.k8s;
const eksK8s = (s: LabState) => view(s).cloud.aws.eks.clusters.lab.k8s;

const IMG = "us-docker.pkg.dev/google-samples/containers/gke/hello-app";
const GKE = ["gcloud container clusters create-auto hello --location=us-east4"];
const WEB = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: public.ecr.aws/nginx/nginx:1.23
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
  - port: 80
    targetPort: 80
`;
const SUBNETS = { "subnet-a": { cidr: "10.0.1.0/24", availabilityZone: "us-east-1a" }, "subnet-b": { cidr: "10.0.2.0/24", availabilityZone: "us-east-1b" }, "subnet-c": { cidr: "10.0.3.0/24", availabilityZone: "us-east-1a" } };
const EKS_SEED = { files: { "~/web.yaml": WEB }, cloud: { aws: { vpcs: { "vpc-1": { cidr: "10.0.0.0/16", subnets: SUBNETS } } } } };
const ROLE = "arn:aws:iam::123456789012:role/eksClusterRole";
const EKS = [`aws eks create-cluster --name lab --role-arn ${ROLE} --resources-vpc-config subnetIds=subnet-a,subnet-b`, "aws eks update-kubeconfig --name lab"];
const NODES = "aws eks create-nodegroup --cluster-name lab --nodegroup-name ng --node-role arn:aws:iam::123456789012:role/eksNodeRole --subnets subnet-a subnet-b --scaling-config minSize=1,maxSize=3,desiredSize=2";

describe("kubectl without a cluster", () => {
  it("cannot connect until a kubeconfig context exists", () => {
    expect(sh(createLabState(), "kubectl get pods").error).toContain("localhost:8080 was refused");
  });
});

describe("eks", () => {
  it("needs subnets in two availability zones", () => {
    const s = createLabState(EKS_SEED);
    expect(sh(s, `aws eks create-cluster --name lab --role-arn ${ROLE} --resources-vpc-config subnetIds=subnet-a,subnet-c`).error).toContain("two different AZs");
    expect(sh(s, `aws eks create-cluster --name lab --role-arn ${ROLE} --resources-vpc-config subnetIds=subnet-a,subnet-zz`).error).toContain("subnet-zz");
    const r = sh(s, ...EKS);
    expect(r.text).toBe("Added new context arn:aws:eks:us-east-1:123456789012:cluster/lab to /home/learner/.kube/config");
    expect(view(r.state).kube.currentContext).toBe("arn:aws:eks:us-east-1:123456789012:cluster/lab");
  });

  it("keeps Pods pending until a node group exists", () => {
    let s = sh(createLabState(EKS_SEED), ...EKS, "kubectl apply -f web.yaml").state;
    expect(sh(s, "kubectl get pods").text).toMatch(/web-\w+-\w+\s+0\/1\s+Pending/);
    expect(sh(s, "kubectl get nodes").text).toContain("No resources found");
    const pod = /(web-\w+-\w+)/.exec(sh(s, "kubectl get pods").text)![1];
    expect(sh(s, `kubectl describe pod ${pod}`).text).toContain("FailedScheduling");
    expect(eksK8s(s).services["default/web"].endpoints).toBe(0);
    s = sh(s, NODES).state;
    expect(eksK8s(s).deployments["default/web"]).toEqual({ replicas: 2, readyReplicas: 2, images: ["public.ecr.aws/nginx/nginx:1.23"], revision: 1 });
    expect(eksK8s(s).services["default/web"].endpoints).toBe(2);
    expect(sh(s, "kubectl get nodes").out).toHaveLength(3);
  });
});

describe("kubectl apply and objects", () => {
  it("reports created / unchanged / configured", () => {
    const s = sh(createLabState({ files: { "~/web.yaml": WEB } }), ...GKE).state;
    const first = sh(s, "kubectl apply -f web.yaml");
    expect(first.out).toEqual(["deployment.apps/web created", "service/web created"]);
    expect(sh(first.state, "kubectl apply -f web.yaml").out).toEqual(["deployment.apps/web unchanged", "service/web unchanged"]);
    const changed = sh(first.state, "echo placeholder > x", `kubectl scale deployment web --replicas 4`, "kubectl apply -f web.yaml");
    expect(changed.out).toEqual(["deployment.apps/web configured", "service/web unchanged"]);
  });

  it("rejects selectors that do not match the template labels and unknown namespaces", () => {
    const bad = WEB.replace("        app: web\n    spec", "        app: other\n    spec");
    expect(sh(createLabState({ files: { "~/bad.yaml": bad } }), ...GKE, "kubectl apply -f bad.yaml").error).toContain("does not match template");
    const ns = WEB.replace("  name: web\nspec:\n  replicas", "  name: web\n  namespace: shop\nspec:\n  replicas");
    expect(sh(createLabState({ files: { "~/ns.yaml": ns } }), ...GKE, "kubectl apply -f ns.yaml").error).toContain('namespaces "shop" not found');
    expect(sh(createLabState({ files: { "~/tab.yaml": "kind: Service\n\tbad: x\n" } }), ...GKE, "kubectl apply -f tab.yaml").error).toContain("YAML");
  });

  it("lists everything in a namespace with get all", () => {
    const s = sh(createLabState({ files: { "~/web.yaml": WEB } }), ...GKE, "kubectl apply -f web.yaml").state;
    const text = sh(s, "kubectl get all").text;
    expect(text).toMatch(/pod\/web-\w+-\w+\s+1\/1\s+Running/);
    expect(text).toMatch(/service\/web\s+ClusterIP\s+10\.100\.\S+\s+<none>\s+80\/TCP/);
    expect(text).toMatch(/deployment\.apps\/web\s+2\/2/);
    expect(sh(s, "kubectl get all -n kube-system").text).toContain("No resources found in kube-system namespace.");
    expect(sh(s, "kubectl -n kube-system get all").text).toContain("No resources found in kube-system namespace.");
  });
});

describe("gke workflow", () => {
  it("creates, exposes, scales, self-heals, updates and rolls back", () => {
    let s = sh(createLabState(), ...GKE, `kubectl create deployment hello-server --image=${IMG}:1.0`).state;
    expect(view(s).kube.currentContext).toBe("gke_my-project_us-east4_hello");
    s = sh(s, "kubectl expose deployment hello-server --type LoadBalancer --port 80 --target-port 8080").state;
    expect(gke(s).services["default/hello-server"]).toEqual({ type: "LoadBalancer", port: 80, targetPort: 8080, endpoints: 1, externalIp: true });
    expect(sh(s, "kubectl get service hello-server").text).toMatch(/LoadBalancer\s+\S+\s+34\.118\.\d+\.\d+\s+80:3\d{4}\/TCP/);
    s = sh(s, "kubectl scale deployment hello-server --replicas 3").state;
    const before = sh(s, "kubectl get pods").out.slice(1).map((l) => l.split(/\s+/)[0]);
    s = sh(s, `kubectl delete pod ${before[0]}`).state;
    const after = sh(s, "kubectl get pods").out.slice(1).map((l) => l.split(/\s+/)[0]);
    expect(after).toHaveLength(3);
    expect(after).not.toContain(before[0]);
    s = sh(s, `kubectl set image deployment/hello-server hello-app=${IMG}:2.0`).state;
    expect(gke(s).deployments["default/hello-server"].revision).toBe(2);
    expect(sh(s, "kubectl set image deployment/hello-server web=x").error).toContain('container named "web"');
    s = sh(s, "kubectl rollout undo deployment/hello-server").state;
    expect(gke(s).deployments["default/hello-server"]).toEqual({ replicas: 3, readyReplicas: 3, images: [`${IMG}:1.0`], revision: 3 });
    expect(sh(s, "kubectl rollout history deployment/hello-server").out.slice(2).map((l) => l.trim().split(/\s+/)[0])).toEqual(["2", "3"]);
  });

  it("images in a private registry must exist", () => {
    const s = sh(createLabState(), ...GKE, "kubectl create deployment app --image=asia-east1-docker.pkg.dev/my-project/repo/app:v1").state;
    expect(sh(s, "kubectl get pods").text).toContain("ImagePullBackOff");
    expect(sh(s, "kubectl rollout status deployment/app").error).toContain("0 of 1");
  });
});

describe("kubernetes labs can be completed", () => {
  const labs = new Map([...loadContent().units.values()].flatMap((u) => u.labs).map((l) => [l.id, l]));

  function play(labId: string, groups: (string | ((o: string) => string))[][]): number[] {
    const lab = labs.get(labId)!;
    let state = createLabState(lab.initialState);
    let done = advance(0, state, lab.steps);
    let outputs = "";
    return groups.map((commands) => {
      for (const c of commands) {
        const r = execute(state, typeof c === "string" ? c : c(outputs));
        state = r.state;
        outputs += `${r.lines.map((l) => l.text).join("\n")}\n`;
        done = advance(done, state, lab.steps);
      }
      return done;
    });
  }
  const A = "subnet-0a1b2c3d4e5f60718";
  const B = "subnet-0b2c3d4e5f6071829";
  const C = "subnet-0c3d4e5f607182930";
  const NS = "-n eks-sample-app";

  it("aws-eks-deploy", () => {
    expect(
      play("aws-eks-deploy", [
        ["aws ec2 describe-subnets", `aws eks create-cluster --name lab-eks --role-arn ${ROLE} --resources-vpc-config subnetIds=${A},${C}`, `aws eks create-cluster --name lab-eks --role-arn ${ROLE} --resources-vpc-config subnetIds=${A},${B}`],
        ["aws eks update-kubeconfig --name lab-eks", "kubectl config current-context", "kubectl get nodes"],
        ["kubectl create namespace eks-sample-app", "cd k8s", "cat eks-sample-deployment.yaml", "kubectl apply -f eks-sample-deployment.yaml", `kubectl get pods ${NS}`],
        [`aws eks create-nodegroup --cluster-name lab-eks --nodegroup-name lab-nodes --node-role arn:aws:iam::123456789012:role/eksNodeRole --subnets ${A} ${B} --scaling-config minSize=1,maxSize=3,desiredSize=2`, `kubectl get pods ${NS}`],
        ["kubectl apply -f eks-sample-service.yaml", `kubectl get all ${NS}`, `kubectl ${NS} describe service eks-sample-linux-service`],
        [`kubectl set image deployment/eks-sample-linux-deployment nginx=public.ecr.aws/nginx/nginx:1.24 ${NS}`, `kubectl rollout status deployment/eks-sample-linux-deployment ${NS}`, `kubectl rollout history deployment/eks-sample-linux-deployment ${NS}`],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gcp-gke-deploy", () => {
    expect(
      play("gcp-gke-deploy", [
        ["gcloud container clusters create-auto hello-cluster --location=us-east4", "gcloud container clusters get-credentials hello-cluster --location us-east4", "kubectl get namespaces"],
        [`kubectl create deployment hello-server --image=${IMG}:1.0`, "kubectl get pods"],
        ["kubectl expose deployment hello-server --type LoadBalancer --port 80 --target-port 8080", "kubectl get service hello-server"],
        ["kubectl scale deployment hello-server --replicas 3", "kubectl get pods", (o) => `kubectl delete pod ${/(hello-server-\w+-\w+)/.exec(o)![1]}`, "kubectl get pods"],
        [`kubectl set image deployment/hello-server hello-app=${IMG}:2.0`, "kubectl rollout undo deployment/hello-server", "kubectl rollout history deployment/hello-server"],
      ]),
    ).toEqual([1, 2, 3, 4, 5]);
  });
});
