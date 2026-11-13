/** One simple command: argv plus an optional stdout redirection. */
export interface ParsedCommand {
  argv: string[];
  redirect?: { path: string; append: boolean };
  /** How this command is joined to the previous one. */
  joiner: "first" | "and" | "then";
}

export type ParseResult = { ok: true; commands: ParsedCommand[] } | { ok: false; error: string };

type Token = { type: "word"; value: string } | { type: "op"; value: ">" | ">>" | "&&" | ";" | "|" | "||" | "<" | "&" };

function tokenize(line: string): Token[] | string {
  const tokens: Token[] = [];
  let word: string | null = null;
  let i = 0;
  const pushWord = () => {
    if (word !== null) tokens.push({ type: "word", value: word });
    word = null;
  };

  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t") {
      pushWord();
      i++;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return "引號沒有關閉：缺少 '";
      word = (word ?? "") + line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\" && j + 1 < line.length && '"\\$`'.includes(line[j + 1])) j++;
        text += line[j++];
      }
      if (j >= line.length) return '引號沒有關閉：缺少 "';
      word = (word ?? "") + text;
      i = j + 1;
    } else if (c === "\\") {
      if (i + 1 >= line.length) return "指令不能以 \\ 結尾";
      word = (word ?? "") + line[i + 1];
      i += 2;
    } else if (c === "#" && word === null) {
      break; // comment to end of line
    } else if (">&|;<".includes(c)) {
      pushWord();
      const two = line.slice(i, i + 2);
      if (two === ">>" || two === "&&" || two === "||") {
        tokens.push({ type: "op", value: two });
        i += 2;
      } else {
        tokens.push({ type: "op", value: c as ">" | "&" | "|" | ";" | "<" });
        i++;
      }
    } else {
      word = (word ?? "") + c;
      i++;
    }
  }
  pushWord();
  return tokens;
}

const UNSUPPORTED: Record<string, string> = {
  "|": "這個模擬終端機不支援管線（|）",
  "||": "這個模擬終端機不支援 ||",
  "<": "這個模擬終端機不支援輸入重新導向（<）",
  "&": "這個模擬終端機不支援背景執行（&）",
};

/**
 * Parses one input line. Supports quotes, backslash escapes, comments,
 * `>` / `>>` redirection, and chaining with `&&` and `;`.
 */
export function parseLine(line: string): ParseResult {
  const tokens = tokenize(line);
  if (typeof tokens === "string") return { ok: false, error: tokens };

  const commands: ParsedCommand[] = [];
  let current: ParsedCommand = { argv: [], joiner: "first" };
  const finish = (next: "and" | "then"): string | null => {
    if (current.argv.length === 0) return `語法錯誤：「${next === "and" ? "&&" : ";"}」前面缺少指令`;
    commands.push(current);
    current = { argv: [], joiner: next };
    return null;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "word") {
      current.argv.push(t.value);
    } else if (t.value === ">" || t.value === ">>") {
      const target = tokens[++i];
      if (!target || target.type !== "word") return { ok: false, error: `語法錯誤：「${t.value}」後面缺少檔名` };
      current.redirect = { path: target.value, append: t.value === ">>" };
    } else if (t.value === "&&" || t.value === ";") {
      const error = finish(t.value === "&&" ? "and" : "then");
      if (error) return { ok: false, error };
    } else {
      return { ok: false, error: UNSUPPORTED[t.value] };
    }
  }

  if (current.argv.length > 0) commands.push(current);
  else if (current.joiner === "and") return { ok: false, error: "語法錯誤：「&&」後面缺少指令" };
  else if (current.redirect) return { ok: false, error: "語法錯誤：缺少指令" };
  return { ok: true, commands };
}
