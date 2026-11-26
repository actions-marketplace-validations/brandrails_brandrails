import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDtcg } from "../dtcg.js";
import { OPTIONAL_RULES_FILES, RULES_FILES, renderAll } from "../generate.js";
import { nearestColourToken } from "./nearest.js";
import { addedLines, DEFAULT_IGNORE, globToRegExp, scanLines, STYLE_FILE, type AddedLine, type Finding } from "./scan.js";

export interface CheckOptions {
  root: string;
  tokens: string;
  /** Branch or commit to compare against; added lines since the merge base are scanned. */
  base: string;
  /** Scan every line of every tracked file instead of the diff: an audit of the whole repo. */
  all?: boolean;
  /** Extra globs to skip, on top of build output. */
  ignore?: string[];
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** `main` locally, or `origin/main` in a CI checkout that only has remote branches. */
function resolveBase(root: string, base: string): string {
  for (const ref of [base, `origin/${base}`]) {
    try {
      git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return ref;
    } catch {}
  }
  throw new Error(`Base "${base}" not found. In GitHub Actions, check out with fetch-depth: 0.`);
}

/** Rules files that differ from what `brandrails generate` would write now. */
export function staleFiles(root: string, tokensPath: string): string[] {
  const abs = (p: string) => join(root, p);
  if (!existsSync(abs(tokensPath))) return [];
  const read = (p: string) => (existsSync(abs(p)) ? readFileSync(abs(p), "utf8") : "");
  const { tokens } = parseDtcg(read(tokensPath));
  // Match whichever layout the repo was generated with.
  const full = read("AGENTS.md").includes("| Token | Value | Notes |");
  return Object.entries(renderAll(tokens, read, { full }))
    .filter(([path]) => !OPTIONAL_RULES_FILES.has(path) || existsSync(abs(path)))
    .filter(([path, content]) => read(path) !== content)
    .map(([path]) => path);
}

/** Files above this size are skipped by `--all`; they are generated or vendored, not hand-written styles. */
const MAX_AUDIT_BYTES = 1024 * 1024;

/** Every line of every tracked style or component file, as if all of it were new. */
function trackedLines(root: string): AddedLine[] {
  const out: AddedLine[] = [];
  for (const file of git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0")) {
    if (!file || !STYLE_FILE.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // deleted in the working tree, or a submodule
    }
    if (text.length > MAX_AUDIT_BYTES) continue;
    text.split("\n").forEach((line, i) => out.push({ file, line: i + 1, text: line }));
  }
  return out;
}

export function check({ root, tokens, base, all = false, ignore = [] }: CheckOptions): Finding[] {
  const lines = all
    ? trackedLines(root)
    : addedLines(git(root, ["diff", "--relative", "--unified=0", "--no-color", "--no-ext-diff", "--diff-filter=AM", `${resolveBase(root, base)}...HEAD`]));
  const generated = new Set<string>([...RULES_FILES, tokens]);
  const ignored = [...DEFAULT_IGNORE, ...ignore].map(globToRegExp);
  const nearest = existsSync(join(root, tokens)) ? nearestColourToken(parseDtcg(readFileSync(join(root, tokens), "utf8")).tokens) : undefined;
  const findings = scanLines(lines, (file) => generated.has(file) || ignored.some((re) => re.test(file)), nearest);
  for (const path of staleFiles(root, tokens)) {
    findings.push({ file: path, line: 1, rule: "stale-rules", message: `Out of date with ${tokens}: run brandrails generate` });
  }
  return findings;
}
