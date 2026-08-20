const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(\s*https?:\/\/[^)\s]+(?:\s+["'][^)]*["'])?\s*\)/gu;
const HTML_LINK_PATTERN = /<a\b[^>]*>\s*([^<]+?)\s*<\/a>/giu;
const RAW_URL_PATTERN = /https?:\/\/[^\s)]+/gu;
const SOURCE_LINE_PATTERN = /^\s*(?:#{1,6}\s*)?(?:출처|참고\s*(?:자료|문헌)?|확인한\s*(?:자료|원문)|sources?)\s*:?[\s]*/iu;

export function stripBrunchSourcesForCopy(markdown) {
  const source = String(markdown ?? "").replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
  const lines = source.split("\n");
  const cleaned = lines.map((line) => {
    const hadUrl = /https?:\/\//iu.test(line);
    let next = line.replace(MARKDOWN_LINK_PATTERN, "$1").replace(HTML_LINK_PATTERN, "$1").replace(RAW_URL_PATTERN, "");
    if (hadUrl && SOURCE_LINE_PATTERN.test(line)) return "";
    if (SOURCE_LINE_PATTERN.test(next) && !next.replace(SOURCE_LINE_PATTERN, "").trim()) return "";
    return next.replace(/[ \t]+$/gu, "");
  });
  return cleaned.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}
