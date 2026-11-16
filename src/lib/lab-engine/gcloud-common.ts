import type { Ctx } from "./context";

export function error(ctx: Ctx, command: string, message: string): number {
  ctx.err(`ERROR: (${command}) ${message}`);
  return 1;
}

export const NAME = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const NAME_RULE = "名稱必須以小寫字母開頭，只能包含小寫字母、數字和連字號，最多 63 個字元。";
/** "asia-east1-b" -> "asia-east1". */
export const zoneRegion = (zone: string) => zone.slice(0, zone.lastIndexOf("-"));
export const list = (value: string | undefined) => (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);

export function table(ctx: Ctx, header: string[], rows: string[][]) {
  if (rows.length === 0) {
    ctx.out("Listed 0 items.\n");
    return;
  }
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)) + 2);
  for (const row of [header, ...rows]) ctx.out(`${row.map((cell, i) => cell.padEnd(widths[i])).join("").trimEnd()}\n`);
}


export const networkUrl = (project: string, network: string) => `https://www.googleapis.com/compute/v1/projects/${project}/global/networks/${network}`;
export const subnetUrl = (project: string, region: string, subnet: string) =>
  `https://www.googleapis.com/compute/v1/projects/${project}/regions/${region}/subnetworks/${subnet}`;

