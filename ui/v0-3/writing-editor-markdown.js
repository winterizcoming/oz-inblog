import { markdownToHtml } from "./renderers.js";

const BLOCK_TAGS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "OL", "P", "PRE", "SECTION", "UL"]);

function textContent(node) {
  return Array.from(node.childNodes ?? []).map(inlineMarkdown).join("");
}
function inlineMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.replaceAll("\u00a0", " ") ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName;
  if (tag === "BR") return "\n";
  const content = textContent(node);
  if (tag === "STRONG" || tag === "B") return `**${content}**`;
  if (tag === "EM" || tag === "I") return `*${content}*`;
  if (tag === "CODE") return `\`${content}\``;
  if (tag === "A") {
    const href = node.getAttribute("href") ?? "";
    return href ? `[${content}](${href})` : content;
  }
  return content;
}

function cleanBlockText(value) {
  return String(value ?? "")
    .replaceAll("\u00a0", " ")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .trim();
}

function listMarkdown(element) {
  const ordered = element.tagName === "OL";
  return Array.from(element.children)
    .filter((child) => child.tagName === "LI")
    .map((child, index) => `${ordered ? `${index + 1}.` : "-"} ${cleanBlockText(textContent(child))}`)
    .filter((line) => line.trim())
    .join("\n");
}

function blockMarkdown(element) {
  const tag = element.tagName;
  if (tag === "UL" || tag === "OL") return listMarkdown(element);
  const content = cleanBlockText(textContent(element));
  if (!content) return "";
  if (/^H[1-3]$/u.test(tag)) return `${"#".repeat(Number(tag.slice(1)))} ${content}`;
  if (tag === "BLOCKQUOTE") return content.split("\n").map((line) => `> ${line}`).join("\n");
  return content;
}

export function markdownToEditorHtml(markdown = "") {
  return markdownToHtml(markdown);
}

export function editorHtmlToMarkdown(root) {
  if (!root) return "";
  const blocks = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = cleanBlockText(node.nodeValue);
      if (text) blocks.push(text);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (BLOCK_TAGS.has(node.tagName)) {
      const block = blockMarkdown(node);
      if (block) blocks.push(block);
      continue;
    }
    const inline = cleanBlockText(inlineMarkdown(node));
    if (inline) blocks.push(inline);
  }
  return blocks.join("\n\n");
}

function closestBlock(node, root) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const block = element?.closest?.("p, h1, h2, h3, div, li, blockquote");
  return block && root.contains(block) ? block : null;
}

function placeCaretAtEnd(element) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function applyMarkdownShortcut(root) {
  if (typeof window === "undefined" || typeof document === "undefined" || !root) return false;
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return false;
  const block = closestBlock(selection.anchorNode, root);
  if (!block) return false;
  const match = String(block.textContent ?? "").match(/^(#{1,3})\s(.*)$/u);
  if (!match) return false;
  const heading = document.createElement(`h${match[1].length}`);
  heading.textContent = match[2];
  block.replaceWith(heading);
  placeCaretAtEnd(heading);
  return true;
}
