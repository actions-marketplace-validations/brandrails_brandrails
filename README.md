# Brandrails

**Keep AI coding agents on your design system.**

Brandrails turns the design decisions already in your codebase into one `tokens.json` ([DTCG format](https://www.designtokens.org/)), generates design rules for every AI tool your team uses, and flags drift on every pull request.

> Status: v0.5, early. Feedback and issues welcome. See the [changelog](CHANGELOG.md).

## What it does

1. **Reads** tokens from Tailwind v4 `@theme`, CSS custom properties (including shadcn/ui themes such as `--primary: 221 83% 53%`), SCSS variables and maps, and Angular (`angular.json` styles, Angular Material 3 themes). It tells you what it left out: dark-theme overrides and page-scoped palettes outside `:root`.
2. **Writes** one DTCG `tokens.json` as the single source of truth.
3. **Generates** rules for:
   - `AGENTS.md` (design section) and `CLAUDE.md` (imports `@AGENTS.md`)
   - `.cursor/rules/design.mdc`
   - `.github/copilot-instructions.md`
   - `GEMINI.md` (Gemini CLI, imports `@AGENTS.md`)
   - `.windsurf/rules/design.md` (Windsurf, attached to UI files only)
   - Figma Make guidelines (markdown)
   - `design/tokens.md`, the full reference with values and usage notes

   Files agents load on every request (AGENTS.md, Copilot) only list token names and point to `design/tokens.md`, so a big design system doesn't eat the context window. The Cursor rule attaches only when a UI file is involved. Pass `--full` to put full tables everywhere.
4. **Checks** each PR for hard-coded colours and px values, and for rules files that are stale compared with `tokens.json`.

## Ways to use it

### As an agent skill

The skill is the folder [`skill/brandrails/`](skill/brandrails/SKILL.md), laid out the way agents discover skills. Install it with:

```bash
npx brandrails skill                  # Claude Code: .claude/skills/brandrails/SKILL.md
npx brandrails skill --agent codex    # or cursor
```

or copy the folder yourself, with no renaming:

```bash
cp -r node_modules/brandrails/skill/brandrails .claude/skills/
```

Then run `/brandrails` in your agent, or ask it to "make this repo AI-ready".

### As a GitHub Action

```yaml
on: pull_request
jobs:
  brandrails:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: brandrails/brandrails@v1
        with:
          command: check
          tokens: tokens.json
          ignore: "public/** legacy/**"   # optional
```

Problems show up as annotations on the PR diff.

### As an MCP server (Claude, Cursor, Codex, ChatGPT)

`brandrails mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server with no extra dependencies.

| Tool | What it does | Where |
|-|-|-|
| `extract_tokens` | Stylesheets in, DTCG `tokens.json` out | local and hosted |
| `generate_rules` | `tokens.json` in, the rules files out | local and hosted |
| `check_drift` | A git diff or files in, hard-coded colours and px values out | local and hosted |
| `generate_in_repo` | `brandrails generate` in a repository on your machine | local only |
| `check_repo` | `brandrails check` in a repository on your machine | local only |

**Claude Code plugin** (MCP server plus the skill):

```bash
claude plugin marketplace add brandrails/brandrails
claude plugin install brandrails@brandrails
```

**Cursor, Claude Desktop, Codex** and other clients that run local servers:

```json
{ "mcpServers": { "brandrails": { "command": "npx", "args": ["-y", "brandrails", "mcp"] } } }
```

**Hosted (ChatGPT apps, Claude connectors):** these clients need a public HTTPS URL.

```bash
BRANDRAILS_MCP_TOKEN=optional-secret npx brandrails mcp --http --host 0.0.0.0 --port 8787
# MCP endpoint: https://<your-host>/mcp   health check: /health
```

On **Vercel**, import the repository as a project; `vercel.json` and `api/mcp.ts` serve the same endpoint at `https://<project>.vercel.app/mcp`. Set `BRANDRAILS_MCP_TOKEN` in the project's environment variables to require a token.

The hosted server offers only the three content tools. It holds supplied files in a temporary folder for the length of one call, never reads outside them, and keeps nothing afterwards. Requests are capped at 100 files and 2 MB.

### CLI

Node 20 or newer. Run it in your project:

```bash
# First run: read tokens from your CSS and create tokens.json, the rules files and design/tokens.md
npx brandrails generate --from src/index.css

# SCSS and Angular work the same way
npx brandrails generate --from src/styles.scss
npx brandrails generate --from angular.json   # or just `generate` in an Angular workspace with no tokens.json yet

# After that, edit tokens.json and regenerate. A second run with no changes writes nothing.
npx brandrails generate
```

Check a branch for design drift (what the GitHub Action runs on every PR):

```bash
npx brandrails check --base main --ignore "public/**"
```

It scans only lines added since `main` and fails on hard-coded hex, `rgb()`/`hsl()` colours and px spacing or radius (CSS declarations, Tailwind values like `p-[13px]` and Angular bindings like `[style.padding.px]`). Token definitions (`--color-x: #fff`, `$color-x: #fff`, SCSS map entries), `0px`, border widths and build output are allowed. It also fails when the rules files are out of date with `tokens.json`. Put `brandrails-ignore` in a comment on a line to allow it.

Audit the whole repository instead of one branch, for example before you adopt Brandrails or to measure how much legacy styling is left:

```bash
npx brandrails check --all                  # every tracked style and component file
npx brandrails check --all --format json    # { problemCount, byRule, findings } for scripts and dashboards
```

For a hard-coded colour close to a token, the message names it:

```
src/Hero.tsx:5  Hard-coded #2563ea: use `color.primary`, the closest colour token
```

## Roadmap

- **v0.1** — React + Tailwind v4 and plain CSS readers, the rules writers, drift check
- **v0.2** — Angular (`angular.json`, Material 3 themes), SCSS variables and maps, skill shipped as `skill/brandrails/SKILL.md`
- **v0.3** — shadcn/ui and Lovable themes, nearest-token suggestions in `check`
- **v0.4** — MCP server (stdio and HTTP) and Claude Code plugin
- **v0.5** — Gemini CLI and Windsurf rules, `check --all` and `--format json`
- **v0.6** — Figma variables compare, Vue and web components

## License

[MIT](LICENSE) © Matej Holek
