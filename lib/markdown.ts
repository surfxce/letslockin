import { marked } from "marked";

/**
 * Summaries are model-generated from the user's own lecture files on a local
 * single-user app, but they are still untrusted text, so strip the handful of
 * things that could execute before they reach dangerouslySetInnerHTML.
 */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return html
    .replace(/<\s*(script|iframe|object|embed|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}
