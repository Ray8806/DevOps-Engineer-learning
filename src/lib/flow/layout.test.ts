import { describe, expect, it } from "vitest";
import { FlowSchema } from "@/lib/content/schema";
import { CELL_H, CELL_W, NODE_H, NODE_W, layoutFlow, stepView } from "./layout";

const flow = FlowSchema.parse({
  id: "demo",
  title: "demo",
  nodes: [
    { id: "a", label: "A", col: 0, row: 0 },
    { id: "b", label: "B", col: 1, row: 0 },
    { id: "c", label: "C", col: 1, row: 1 },
  ],
  steps: [
    { from: "a", to: "b", text: "a to b" },
    { from: "b", text: "b alone" },
    { from: "b", to: "a", text: "back" },
    { from: "b", to: "c", text: "fails", status: "fail" },
  ],
});

describe("layoutFlow", () => {
  it("places nodes on the grid and swaps axes on narrow screens", () => {
    const wide = layoutFlow(flow, "wide");
    expect([wide.width, wide.height]).toEqual([2 * CELL_W, 2 * CELL_H]);
    expect(wide.nodes.find((n) => n.id === "c")).toMatchObject({ x: CELL_W * 1.5, y: CELL_H * 1.5 });
    const narrow = layoutFlow(flow, "narrow");
    expect(narrow.nodes.find((n) => n.id === "b")).toMatchObject({ x: CELL_W / 2, y: CELL_H * 1.5 });
  });

  it("draws one edge per direction, from box border to box border", () => {
    const { edges } = layoutFlow(flow, "wide");
    expect(edges.map((e) => e.key).sort()).toEqual(["a>b", "b>a", "b>c"]);
    const down = edges.find((e) => e.key === "b>c")!;
    expect(down.x1).toBe(down.x2);
    expect(down.y1).toBeCloseTo(CELL_H / 2 + NODE_H / 2 + 2);
    expect(down.y2).toBeCloseTo(CELL_H * 1.5 - NODE_H / 2 - 5);
    // Edges used both ways are pulled apart so they do not overlap.
    const ab = edges.find((e) => e.key === "a>b")!;
    const ba = edges.find((e) => e.key === "b>a")!;
    expect(ab.y1).not.toBe(ba.y1);
    expect(ab.x1).toBeCloseTo(CELL_W / 2 + NODE_W / 2 + 2);
  });
});

describe("stepView", () => {
  it("shows everything plainly before the first step", () => {
    const v = stepView(flow, -1);
    expect(Object.values(v.nodes)).toEqual(["idle", "idle", "idle"]);
    expect(v.moving).toBeNull();
  });

  it("fades what is not reached yet and marks the current step", () => {
    const v = stepView(flow, 0);
    expect(v.nodes).toEqual({ a: "active", b: "active", c: "upcoming" });
    expect(v.edges).toEqual({ "a>b": "active", "b>a": "upcoming", "b>c": "upcoming" });
    expect(v.moving).toBe("a>b");
  });

  it("keeps earlier steps as done and highlights a single node", () => {
    const v = stepView(flow, 1);
    expect(v.nodes).toEqual({ a: "seen", b: "active", c: "upcoming" });
    expect(v.edges["a>b"]).toBe("done");
    expect(v.moving).toBeNull();
  });

  it("marks failed steps", () => {
    const v = stepView(flow, 3);
    expect(v.nodes).toEqual({ a: "seen", b: "active", c: "failed" });
    expect(v.edges).toEqual({ "a>b": "done", "b>a": "done", "b>c": "failed" });
    expect(v.failed).toBe(true);
  });
});
