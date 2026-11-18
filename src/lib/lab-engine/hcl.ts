/**
 * A small parser for the subset of HCL that introductory Terraform uses:
 * blocks with labels, attributes, strings with ${} interpolation, numbers,
 * booleans, lists, objects, and references such as var.x or a.b.attr.
 */

export type Expr =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "template"; parts: (string | Expr)[] }
  | { kind: "ref"; path: string[] }
  | { kind: "list"; items: Expr[] }
  | { kind: "object"; entries: [string, Expr][] };

export interface Block {
  type: string;
  labels: string[];
  attributes: Map<string, Expr>;
  blocks: Block[];
  line: number;
}

type Token = { t: "ident" | "string" | "number" | "punct" | "nl"; v: string; line: number; parts?: (string | Expr)[] };

export class HclError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(message);
  }
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      out.push({ t: "nl", v: "\n", line });
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") i++;
    else if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) throw new HclError("Unterminated template string（/* 註解沒有結束）", line);
      line += src.slice(i, end).split("\n").length - 1;
      i = end + 2;
    } else if (c === '"') {
      const start = line;
      const parts: (string | Expr)[] = [];
      let text = "";
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\n") throw new HclError("Unterminated template string（字串沒有用 \" 結束）", start);
        if (src[i] === "\\" && i + 1 < src.length) {
          text += { n: "\n", t: "\t", '"': '"', "\\": "\\" }[src[i + 1]] ?? src[i + 1];
          i += 2;
        } else if (src[i] === "$" && src[i + 1] === "{") {
          const end = src.indexOf("}", i);
          if (end === -1) throw new HclError("Invalid template interpolation（${ 沒有用 } 結束）", line);
          if (text) parts.push(text);
          text = "";
          parts.push(parseExpr(tokenize(src.slice(i + 2, end)).filter((tk) => tk.t !== "nl"), { pos: 0 }, line));
          i = end + 1;
        } else text += src[i++];
      }
      if (i >= src.length) throw new HclError("Unterminated template string（字串沒有用 \" 結束）", start);
      i++;
      if (text || !parts.length) parts.push(text);
      out.push({ t: "string", v: parts.filter((p) => typeof p === "string").join(""), line: start, parts });
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: "number", v: src.slice(i, j), line });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_\-.]/.test(src[j])) j++;
      out.push({ t: "ident", v: src.slice(i, j), line });
      i = j;
    } else if ("{}[]=,:".includes(c)) {
      out.push({ t: "punct", v: c, line });
      i++;
    } else throw new HclError(`Invalid character: '${c}'`, line);
  }
  return out;
}

function parseExpr(tokens: Token[], at: { pos: number }, line: number): Expr {
  const skipNl = () => {
    while (tokens[at.pos]?.t === "nl") at.pos++;
  };
  skipNl();
  const tk = tokens[at.pos++];
  if (!tk) throw new HclError("Invalid expression（= 後面缺少值）", line);
  if (tk.t === "string") return tk.parts!.length === 1 && typeof tk.parts![0] === "string" ? { kind: "literal", value: tk.parts![0] } : { kind: "template", parts: tk.parts! };
  if (tk.t === "number") return { kind: "literal", value: Number(tk.v) };
  if (tk.t === "ident") {
    if (tk.v === "true" || tk.v === "false") return { kind: "literal", value: tk.v === "true" };
    if (tk.v === "null") return { kind: "literal", value: null };
    return { kind: "ref", path: tk.v.split(".") };
  }
  if (tk.v === "[") {
    const items: Expr[] = [];
    skipNl();
    while (tokens[at.pos] && tokens[at.pos].v !== "]") {
      items.push(parseExpr(tokens, at, tk.line));
      skipNl();
      if (tokens[at.pos]?.v === ",") at.pos++;
      skipNl();
    }
    if (!tokens[at.pos]) throw new HclError("Missing item separator（[ 沒有用 ] 結束）", tk.line);
    at.pos++;
    return { kind: "list", items };
  }
  if (tk.v === "{") {
    const entries: [string, Expr][] = [];
    skipNl();
    while (tokens[at.pos] && tokens[at.pos].v !== "}") {
      const key = tokens[at.pos++];
      if (key.t !== "ident" && key.t !== "string") throw new HclError("Invalid object key", key.line);
      if (tokens[at.pos]?.v !== "=" && tokens[at.pos]?.v !== ":") throw new HclError("Missing key/value separator（物件的鍵後面要有 =）", key.line);
      at.pos++;
      entries.push([key.v, parseExpr(tokens, at, key.line)]);
      skipNl();
      if (tokens[at.pos]?.v === ",") at.pos++;
      skipNl();
    }
    if (!tokens[at.pos]) throw new HclError("Unclosed configuration block（{ 沒有用 } 結束）", tk.line);
    at.pos++;
    return { kind: "object", entries };
  }
  throw new HclError(`Invalid expression: 不認得 '${tk.v}'`, tk.line);
}

function parseBody(tokens: Token[], at: { pos: number }, closing: boolean): { attributes: Map<string, Expr>; blocks: Block[] } {
  const attributes = new Map<string, Expr>();
  const blocks: Block[] = [];
  for (;;) {
    while (tokens[at.pos]?.t === "nl") at.pos++;
    const tk = tokens[at.pos];
    if (!tk) {
      if (closing) throw new HclError("Unclosed configuration block（區塊的 { 沒有用 } 結束）", tokens.at(-1)?.line ?? 1);
      return { attributes, blocks };
    }
    if (tk.v === "}") {
      if (!closing) throw new HclError("Argument or block definition required（多了一個 }）", tk.line);
      at.pos++;
      return { attributes, blocks };
    }
    if (tk.t !== "ident") throw new HclError(`Argument or block definition required（不認得 '${tk.v}'）`, tk.line);
    at.pos++;
    if (tokens[at.pos]?.v === "=") {
      at.pos++;
      if (attributes.has(tk.v)) throw new HclError(`Attribute redefined: The argument "${tk.v}" was already set`, tk.line);
      attributes.set(tk.v, parseExpr(tokens, at, tk.line));
      const next = tokens[at.pos];
      if (next && next.t !== "nl" && next.v !== "}") throw new HclError("Missing newline after argument（每個屬性要獨立一行）", tk.line);
      continue;
    }
    const labels: string[] = [];
    while (tokens[at.pos]?.t === "string" || tokens[at.pos]?.t === "ident") labels.push(tokens[at.pos++].v);
    if (tokens[at.pos]?.v !== "{") throw new HclError(`Invalid block definition: 「${tk.v}」後面要接 = 或 {`, tk.line);
    at.pos++;
    const body = parseBody(tokens, at, true);
    blocks.push({ type: tk.v, labels, ...body, line: tk.line });
  }
}

export function parseHcl(src: string): Block[] {
  const tokens = tokenize(src);
  return parseBody(tokens, { pos: 0 }, false).blocks;
}
