/** IPv4 CIDR blocks as numbers, for range checks in the network commands. */
export interface Cidr {
  /** Network address (host bits cleared) as an unsigned 32-bit number. */
  base: number;
  prefix: number;
  /** True when the input already had its host bits cleared, e.g. 10.0.1.0/24 rather than 10.0.1.5/24. */
  canonical: boolean;
}

const PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export function parseCidr(text: string): Cidr | null {
  const m = PATTERN.exec(text);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return null;
  const ip = octets.reduce((acc, o) => acc * 256 + o, 0);
  const base = ip - (ip % 2 ** (32 - prefix));
  return { base, prefix, canonical: base === ip };
}

export function formatCidr(cidr: Cidr): string {
  const octets = [24, 16, 8, 0].map((shift) => Math.floor(cidr.base / 2 ** shift) % 256);
  return `${octets.join(".")}/${cidr.prefix}`;
}

export const cidrSize = (cidr: Cidr) => 2 ** (32 - cidr.prefix);

/** True when `inner` lies entirely inside `outer`. */
export function cidrContains(outer: Cidr, inner: Cidr): boolean {
  return inner.base >= outer.base && inner.base + cidrSize(inner) <= outer.base + cidrSize(outer);
}

export function cidrOverlaps(a: Cidr, b: Cidr): boolean {
  return a.base < b.base + cidrSize(b) && b.base < a.base + cidrSize(a);
}
