/**
 * Zip files in the simulator are plain text: a marker line followed by the
 * archived files as JSON, so `cat` shows what is inside and commands such as
 * `aws lambda create-function` can read the package back.
 */
const MARKER = "PK（模擬的 zip 封存檔，內容如下）";

export function encodeArchive(files: Record<string, string>): string {
  return `${MARKER}\n${JSON.stringify(files, null, 2)}\n`;
}

/** The archived files, or null when the text is not a simulated zip file. */
export function decodeArchive(text: string): Record<string, string> | null {
  if (!text.startsWith(`${MARKER}\n`)) return null;
  try {
    const files: unknown = JSON.parse(text.slice(MARKER.length + 1));
    return typeof files === "object" && files !== null && !Array.isArray(files) ? (files as Record<string, string>) : null;
  } catch {
    return null;
  }
}
