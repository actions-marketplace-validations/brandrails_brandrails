import type { TokenGroup } from "../dtcg.js";
import { renderRules, type RenderOptions } from "./rules.js";

/**
 * Brandrails owns this whole file. Windsurf applies a `trigger: glob` rule only when a matching
 * UI file is in play, and caps each rule file at a few thousand characters, so by default it gets
 * the compact index that points to design/tokens.md.
 */
export function writeWindsurf(tokens: TokenGroup, { full }: RenderOptions = {}): string {
  return [
    "---",
    "trigger: glob",
    "description: Design system tokens. Use them for all UI styling.",
    "globs: \"**/*.{css,scss,html,jsx,tsx,vue,svelte}\"",
    "---",
    "",
    renderRules(tokens, 1, full ? "table" : "index"),
    "",
  ].join("\n");
}
