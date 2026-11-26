import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { check } from "../check/index.js";
import { nearestColourToken } from "../check/nearest.js";
import { addedLines, scanLines, type Finding } from "../check/scan.js";
import { parseDtcg } from "../dtcg.js";
import { generate, renderAll, tokensFromFiles } from "../generate.js";

/** JSON Schema for a tool's arguments (the subset MCP clients read). */
type Schema = Record<string, unknown>;

export interface ToolResult {
  /** Short text for the model; the full data is in `data`. */
  text: string;
  data: Record<string, unknown>;
  isError?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean; idempotentHint?: boolean };
  run: (args: Record<string, unknown>) => ToolResult;
}

export class ToolInputError extends Error {}

/** Limits for the content tools, so one call cannot fill the server's memory or disk. */
export const LIMITS = { files: 100, bytes: 2 * 1024 * 1024 };

const FILES_SCHEMA = {
  type: "array",
  maxItems: LIMITS.files,
  items: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root, e.g. src/styles/tokens.scss." },
      content: { type: "string", description: "The file's full text." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
} as const;

const TOKENS_SCHEMA = { type: "string", description: "The DTCG tokens.json file, as text." } as const;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };

interface SuppliedFile {
  path: string;
  content: string;
}

function files(value: unknown, name = "files"): SuppliedFile[] {
  if (!Array.isArray(value)) throw new ToolInputError(`${name} must be an array of { path, content }.`);
  if (value.length > LIMITS.files) throw new ToolInputError(`At most ${LIMITS.files} files per call.`);
  let bytes = 0;
  return value.map((f, i) => {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
      throw new ToolInputError(`${name}[${i}] needs a string path and content.`);
    }
    bytes += Buffer.byteLength(f.content);
    if (bytes > LIMITS.bytes) throw new ToolInputError(`Files add up to more than ${LIMITS.bytes / 1024 / 1024} MB.`);
    return { path: safePath(f.path), content: f.content };
  });
}

/** A relative path that stays inside the folder it is joined to. */
function safePath(path: string): string {
  const clean = normalize(path.replace(/\\/g, "/")).replace(/^(\.\/)+/, "");
  if (!clean || isAbsolute(clean) || clean === ".." || clean.startsWith("../") || clean.includes("\0")) {
    throw new ToolInputError(`Path "${path}" must be relative and stay inside the project.`);
  }
  return clean;
}

function str(value: unknown, name: string, required: true): string;
function str(value: unknown, name: string, required?: false): string | undefined;
function str(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ToolInputError(`${name} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new ToolInputError(`${name} must be a string.`);
  return value;
}

function strings(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new ToolInputError(`${name} must be an array of strings.`);
  return value as string[];
}

function tokensFrom(text: string) {
  try {
    return parseDtcg(text);
  } catch (error) {
    throw new ToolInputError(`tokens is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function count(tokens: unknown): number {
  if (!tokens || typeof tokens !== "object") return 0;
  if ("$value" in tokens) return 1;
  return Object.entries(tokens).reduce((n, [key, value]) => (key.startsWith("$") ? n : n + count(value)), 0);
}

function summarise(findings: Finding[]): string {
  if (!findings.length) return "No design drift found.";
  const lines = findings.slice(0, 50).map((f) => `${f.file}:${f.line}  ${f.message}`);
  if (findings.length > 50) lines.push(`… and ${findings.length - 50} more`);
  return `${findings.length} problem${findings.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

/** Tools that take file contents as arguments. Safe to host: they never touch the caller's disk. */
export const CONTENT_TOOLS: Tool[] = [
  {
    name: "extract_tokens",
    title: "Extract design tokens",
    description:
      "Read design tokens from stylesheets and return one DTCG tokens.json. Supports Tailwind v4 @theme, CSS custom properties (incl. shadcn/ui themes), SCSS variables and maps, angular.json and Angular Material 3. Pass the entry stylesheet(s) plus any SCSS partials they @use; also returns notes on what was not read (dark-theme overrides, scoped palettes).",
    inputSchema: {
      type: "object",
      properties: {
        files: { ...FILES_SCHEMA, description: "Stylesheets (and angular.json) with their paths, so @use / @import partials resolve." },
        entries: {
          type: "array",
          items: { type: "string" },
          description: "Which of the files to start from. Default: every supplied file except SCSS partials (_name.scss); angular.json alone if present.",
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run(args) {
      const supplied = files(args.files);
      if (!supplied.length) throw new ToolInputError("Pass at least one stylesheet in files.");
      const dir = mkdtempSync(join(tmpdir(), "brandrails-"));
      try {
        for (const f of supplied) {
          mkdirSync(dirname(join(dir, f.path)), { recursive: true });
          writeFileSync(join(dir, f.path), f.content);
        }
        const angular = supplied.find((f) => basename(f.path) === "angular.json");
        const entries =
          strings(args.entries, "entries")?.map(safePath) ??
          (angular ? [angular.path] : supplied.filter((f) => /\.(css|scss|sass)$/.test(f.path) && !basename(f.path).startsWith("_")).map((f) => f.path));
        const known = new Set(supplied.map((f) => f.path));
        const missing = entries.filter((e) => !known.has(e));
        if (missing.length) throw new ToolInputError(`entries not among files: ${missing.join(", ")}`);
        if (!entries.length) throw new ToolInputError("No stylesheet to read: pass a .css, .scss, .sass or angular.json file.");
        const { tokens, skipped, notes } = tokensFromFiles(
          entries.map((e) => join(dir, e)),
          dir,
        );
        const tokensJson = JSON.stringify(tokens, null, 2) + "\n";
        const n = count(tokens);
        const cleanNotes = notes.map((note) => note.replaceAll(dir + "/", ""));
        const text = [
          `Read ${n} token${n === 1 ? "" : "s"} into tokens.json.`,
          skipped.length ? `Skipped ${skipped.length} custom properties outside known groups: ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? ", …" : ""}` : "",
          ...cleanNotes.map((note) => `Note: ${note}`),
        ]
          .filter(Boolean)
          .join("\n");
        return { text: `${text}\n\n${tokensJson}`, data: { tokensJson, tokenCount: n, skipped, notes: cleanNotes } };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "generate_rules",
    title: "Generate AI rules files",
    description:
      "Turn a DTCG tokens.json into design rules for AI tools: AGENTS.md (design section), CLAUDE.md, .cursor/rules/design.mdc, .github/copilot-instructions.md, design/figma-make-guidelines.md and design/tokens.md. Pass the current AGENTS.md / copilot-instructions.md so hand-written text outside the brandrails markers is kept. Returns each file's full content.",
    inputSchema: {
      type: "object",
      properties: {
        tokens: TOKENS_SCHEMA,
        existing: {
          type: "object",
          description: 'Current file contents by path, e.g. { "AGENTS.md": "…", "CLAUDE.md": "…" }. Missing files are created.',
          additionalProperties: { type: "string" },
        },
        full: { type: "boolean", description: "Full token tables in every file instead of the compact index. Default false." },
      },
      required: ["tokens"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run(args) {
      const { tokens, untyped } = tokensFrom(str(args.tokens, "tokens", true));
      const existing = (args.existing ?? {}) as Record<string, unknown>;
      if (typeof existing !== "object" || Array.isArray(existing)) throw new ToolInputError("existing must be an object of path → content.");
      const read = (p: string) => (typeof existing[p] === "string" ? (existing[p] as string) : "");
      const out = renderAll(tokens, read, { full: args.full === true });
      const changed = Object.keys(out).filter((p) => out[p] !== read(p));
      const text = [
        changed.length ? `${changed.length} file${changed.length === 1 ? "" : "s"} to write: ${changed.join(", ")}` : "Everything is up to date.",
        untyped.length ? `Warning: ${untyped.length} tokens have no $type: ${untyped.slice(0, 5).join(", ")}` : "",
        ...changed.map((p) => `\n--- ${p} ---\n${out[p]}`),
      ]
        .filter(Boolean)
        .join("\n");
      return { text, data: { files: out, changed, untyped } };
    },
  },
  {
    name: "check_drift",
    title: "Check for design drift",
    description:
      "Find hard-coded colours (hex, rgb, hsl, oklch) and px spacing or radius, including Tailwind arbitrary values like p-[13px], that should use a design token. Pass a unified git diff (only added lines are checked) or whole files. With tokens, each colour finding names the closest colour token.",
    inputSchema: {
      type: "object",
      properties: {
        diff: { type: "string", description: "Output of `git diff` (any context size). Only added lines are checked." },
        files: { ...FILES_SCHEMA, description: "Whole files to check, every line counts as new." },
        tokens: { ...TOKENS_SCHEMA, description: "Optional DTCG tokens.json text, used to suggest the closest token." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run(args) {
      const diff = str(args.diff, "diff");
      const supplied = args.files === undefined ? [] : files(args.files);
      if (diff === undefined && !supplied.length) throw new ToolInputError("Pass a diff or files to check.");
      if (diff && Buffer.byteLength(diff) > LIMITS.bytes) throw new ToolInputError(`diff is larger than ${LIMITS.bytes / 1024 / 1024} MB.`);
      const lines = [
        ...(diff ? addedLines(diff) : []),
        ...supplied.flatMap((f) => f.content.split("\n").map((text, i) => ({ file: f.path, line: i + 1, text }))),
      ];
      const tokensText = str(args.tokens, "tokens");
      const nearest = tokensText ? nearestColourToken(tokensFrom(tokensText).tokens) : undefined;
      const findings = scanLines(lines, undefined, nearest);
      return { text: summarise(findings), data: { findings, problemCount: findings.length } };
    },
  },
];

/** Tools that work on a repository on this machine. Only offered by the local (stdio) server. */
export function localTools(cwd: string): Tool[] {
  const root = (value: unknown) => resolve(cwd, str(value, "root") ?? ".");
  return [
    {
      name: "generate_in_repo",
      title: "Write tokens and rules files in a repository",
      description:
        "Run `brandrails generate` in a local repository: with `from`, read the stylesheets and (re)write tokens.json; then write the rules files. Only changed files are written; hand-written text outside the brandrails markers is kept.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: "Repository folder. Default: the folder the server was started in." },
          tokens: { type: "string", description: "Path to tokens.json, relative to root. Default tokens.json." },
          from: { type: "array", items: { type: "string" }, description: "Stylesheets or angular.json to read tokens from, relative to root." },
          full: { type: "boolean", description: "Full token tables everywhere. Default false." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      run(args) {
        const result = generate({ root: root(args.root), tokens: str(args.tokens, "tokens") ?? "tokens.json", from: strings(args.from, "from"), full: args.full === true });
        const text = [
          result.changed.length ? result.changed.map((p) => `wrote ${p}`).join("\n") : "Everything is up to date.",
          result.skipped.length ? `skipped ${result.skipped.length} custom properties outside known groups` : "",
          ...result.notes.map((n) => `note: ${n}`),
        ]
          .filter(Boolean)
          .join("\n");
        return { text, data: { ...result } };
      },
    },
    {
      name: "check_repo",
      title: "Check a branch for design drift",
      description:
        "Run `brandrails check` in a local git repository: scan lines added since the merge base with `base` (or, with `all`, every tracked file) for hard-coded colours and px values, and report rules files that are stale compared with tokens.json.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: "Repository folder. Default: the folder the server was started in." },
          base: { type: "string", description: "Branch or commit to compare against. Default main." },
          all: { type: "boolean", description: "Audit every tracked file instead of the diff. Default false." },
          tokens: { type: "string", description: "Path to tokens.json, relative to root. Default tokens.json." },
          ignore: { type: "array", items: { type: "string" }, description: 'Extra globs to skip, e.g. ["public/**"].' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      run(args) {
        const findings = check({
          root: root(args.root),
          tokens: str(args.tokens, "tokens") ?? "tokens.json",
          base: str(args.base, "base") ?? "main",
          all: args.all === true,
          ignore: strings(args.ignore, "ignore"),
        });
        return { text: summarise(findings), data: { findings, problemCount: findings.length } };
      },
    },
  ];
}
