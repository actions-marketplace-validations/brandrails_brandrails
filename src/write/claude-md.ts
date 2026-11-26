/**
 * A memory file that only needs to import AGENTS.md; existing content is kept.
 * Claude Code (CLAUDE.md) and Gemini CLI (GEMINI.md) both resolve `@path` imports.
 */
export function importAgentsMd(existing: string): string {
  if (/^@(?:\.\/)?AGENTS\.md\s*$/m.test(existing)) return existing;
  const base = existing.trimEnd();
  return (base ? `${base}\n\n` : "") + "@AGENTS.md\n";
}

export const writeClaudeMd = importAgentsMd;
export const writeGeminiMd = importAgentsMd;
