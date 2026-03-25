<purpose>
Orchestrate parallel codebase mapper agents to analyze codebase and produce structured documents in .planning/codebase/

Each agent has fresh context, explores a specific focus area, and **writes documents directly**. The orchestrator only receives confirmation + line counts, then writes a summary.

Output: .planning/codebase/ folder with 7 structured documents about the codebase state.
</purpose>

<philosophy>
**Why dedicated mapper agents:**
- Fresh context per domain (no token contamination between focus areas)
- Agents write documents directly (no bloated context transfer back to orchestrator)
- Orchestrator only summarizes what was created (minimal context usage)
- Faster execution (agents run simultaneously when Task tool available)

**Document quality over length:**
Include enough detail to be useful as reference. Prioritize practical examples (especially code patterns) over arbitrary brevity.

**Always include file paths:**
Documents are reference material for Claude when planning/executing. Always include actual file paths formatted with backticks: `src/services/user.ts`.

**Idempotent by design:**
Running map-codebase twice should produce consistent results. Existing maps can be refreshed, updated selectively, or skipped entirely.
</philosophy>

<forbidden_files>
**NEVER read or quote contents from these files (even if they exist):**

- `.env`, `.env.*`, `*.env` — Environment variables with secrets
- `credentials.*`, `secrets.*`, `*secret*`, `*credential*` — Credential files
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks` — Certificates and private keys
- `id_rsa*`, `id_ed25519*`, `id_dsa*` — SSH private keys
- `.npmrc`, `.pypirc`, `.netrc` — Package manager auth tokens
- `config/secrets/*`, `.secrets/*`, `secrets/` — Secret directories
- `*.keystore`, `*.truststore` — Java keystores
- `serviceAccountKey.json`, `*-credentials.json` — Cloud service credentials
- `docker-compose*.yml` sections with passwords — May contain inline secrets
- Any file in `.gitignore` that appears to contain secrets

**If you encounter these files:**
- Note their EXISTENCE only: "`.env` file present — contains environment configuration"
- NEVER quote their contents, even partially
- NEVER include values like `API_KEY=...` or `sk-...` in any output

**Why this matters:** Your output gets committed to git. Leaked secrets = security incident.
</forbidden_files>

<critical_rules>

**WRITE DOCUMENTS DIRECTLY.** Do not return findings to orchestrator. The whole point is reducing context transfer.

**ALWAYS INCLUDE FILE PATHS.** Every finding needs a file path in backticks. No exceptions. "UserService handles users" is useless. "`src/services/user.ts` handles user CRUD" is actionable.

**USE THE TEMPLATES.** Fill in the template structure. Don't invent your own format. Replace `[YYYY-MM-DD]` with current date. Replace `[Placeholder text]` with findings. Use "Not detected" or "Not applicable" for empty sections.

**SHOW REAL CODE EXAMPLES.** Especially in CONVENTIONS.md and TESTING.md — paste 5-25 lines of actual code from the codebase to demonstrate patterns. This is more valuable than descriptions.

**BE PRESCRIPTIVE, NOT DESCRIPTIVE.** "Use camelCase for functions" helps the executor write correct code. "Some functions use camelCase" doesn't.

**BE THOROUGH.** Explore deeply. Read actual files. Don't guess. But respect `<forbidden_files>`.

**RETURN ONLY CONFIRMATION.** Your response should be ~10 lines max. Just confirm what was written with file paths and line counts.

**DO NOT COMMIT.** The orchestrator handles git operations.

**ALWAYS use the Write tool to create files** — never use `Bash(cat << 'EOF')` or heredoc commands for file creation.

</critical_rules>

<process>

<step name="init_context" priority="first">
Load codebase mapping context:

```bash
INIT=$(node "/home/joshuaduffill/.claude/get-shit-done/bin/gsd-tools.cjs" init map-codebase)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Extract from init JSON: `mapper_model`, `commit_docs`, `codebase_dir`, `existing_maps`, `has_maps`, `codebase_dir_exists`.

If init fails, use sensible defaults:
- `mapper_model`: "sonnet"
- `commit_docs`: true
- `codebase_dir`: ".planning/codebase"
</step>

<step name="check_existing">
Check if .planning/codebase/ already exists using `has_maps` from init context.

If `codebase_dir_exists` is true:
```bash
ls -la .planning/codebase/
```

**If exists:**

```
.planning/codebase/ already exists with these documents:
[List files found]

What's next?
1. Refresh - Delete existing and remap entire codebase
2. Update - Keep existing, only regenerate specific documents
3. Skip - Use existing codebase map as-is
```

Wait for user response.

If "Refresh": Delete .planning/codebase/, continue to create_structure
If "Update": Ask which documents to update, continue to spawn_agents (filtered to selected focus areas only)
If "Skip": Exit workflow

**If doesn't exist:**
Continue to create_structure.
</step>

<step name="create_structure">
Create .planning/codebase/ directory:

```bash
mkdir -p .planning/codebase
```

**Expected output files (7 total):**
- STACK.md (from tech mapper)
- INTEGRATIONS.md (from tech mapper)
- ARCHITECTURE.md (from arch mapper)
- STRUCTURE.md (from arch mapper)
- CONVENTIONS.md (from quality mapper)
- TESTING.md (from quality mapper)
- CONCERNS.md (from concerns mapper)

Continue to detect_runtime_capabilities.
</step>

<step name="detect_runtime_capabilities">
Before spawning agents, detect whether the current runtime supports the `Task` tool for subagent delegation.

**Runtimes with Task tool:** Claude Code, Cursor (native subagent support)
**Runtimes WITHOUT Task tool:** Antigravity, Gemini CLI, OpenCode, Codex, and others

**How to detect:** Check if you have access to a `Task` tool (or `Agent` tool with subagent_type support). If you do NOT:

-> **Skip `spawn_agents` and `collect_confirmations`** -- go directly to `sequential_mapping` instead.

**CRITICAL:** Never use `browser_subagent` or `Explore` as a substitute for `Task`. The `browser_subagent` tool is exclusively for web page interaction and will fail for codebase analysis. If `Task` is unavailable, perform the mapping sequentially in-context.
</step>

<step name="spawn_agents" condition="Task tool is available">
Spawn 4 parallel gsd-codebase-mapper agents.

Use Task tool with `subagent_type="gsd-codebase-mapper"`, `model="{mapper_model}"`, and `run_in_background=true` for parallel execution.

**CRITICAL:** Use the dedicated `gsd-codebase-mapper` agent, NOT `Explore` or `browser_subagent`. The mapper agent writes documents directly.

**Agent 1: Tech Focus**

```
Task(
  subagent_type="gsd-codebase-mapper",
  model="{mapper_model}",
  run_in_background=true,
  description="Map codebase tech stack",
  prompt="""Focus: tech

Analyze this codebase for technology stack and external integrations.

<exploration_guide>
**Step 1 — Discover package manifests and runtime:**
- Read package.json, requirements.txt, Cargo.toml, go.mod, pyproject.toml, composer.json, Gemfile, build.gradle, pom.xml (whichever exist)
- Check for version pinning files: .nvmrc, .python-version, .ruby-version, .tool-versions, rust-toolchain.toml
- Identify the package manager from lockfiles: package-lock.json, bun.lockb, yarn.lock, pnpm-lock.yaml, Pipfile.lock, poetry.lock, Cargo.lock, go.sum

**Step 2 — Identify frameworks and build tooling:**
- Read config files: tsconfig.json, vite.config.*, next.config.*, webpack.config.*, tailwind.config.*, postcss.config.*, babel.config.*, rollup.config.*
- Check for meta-frameworks: next.config.*, nuxt.config.*, remix.config.*, astro.config.*, svelte.config.*
- Identify build scripts in package.json (or equivalent)

**Step 3 — Map external service integrations:**
- Grep for SDK imports: stripe, supabase, firebase, aws-sdk, @google-cloud, twilio, sendgrid, resend, clerk, auth0, prisma, drizzle, mongoose
- Grep for HTTP client usage: fetch, axios, got, node-fetch, ky — trace where they call external URLs
- Check for ORM/database clients: prisma/schema.prisma, drizzle.config.*, knexfile.*, typeorm, sequelize
- Note database connection patterns (but NEVER read .env values)

**Step 4 — Check infrastructure and deployment:**
- Look for: Dockerfile, docker-compose.yml, fly.toml, vercel.json, netlify.toml, render.yaml, railway.json, Procfile, serverless.yml, terraform/, .github/workflows/, .circleci/, Jenkinsfile
- Check for monitoring: sentry.*, @sentry/*, newrelic.*, datadog-*, pino, winston, bunyan

**Step 5 — Identify auth and security patterns:**
- Grep for auth libraries: passport, next-auth, lucia, clerk, auth0, firebase-admin, jsonwebtoken, bcrypt, argon2
- Check for middleware patterns handling auth
- Note existence of .env files (NOT contents) and how env vars are loaded
</exploration_guide>

Write these documents to .planning/codebase/:
- STACK.md — Languages, runtime, frameworks, dependencies, configuration, platform requirements
- INTEGRATIONS.md — External APIs, databases, auth providers, webhooks, monitoring, CI/CD

Use the document templates. Include file paths with backticks throughout. Return confirmation only."""
)
```

**Agent 2: Architecture Focus**

```
Task(
  subagent_type="gsd-codebase-mapper",
  model="{mapper_model}",
  run_in_background=true,
  description="Map codebase architecture",
  prompt="""Focus: arch

Analyze this codebase architecture and directory structure.

<exploration_guide>
**Step 1 — Map directory structure:**
- List top-level directories and their purposes
- Identify the organizational pattern: feature-based (src/features/), layer-based (src/controllers/, src/services/), domain-driven (src/domains/), or hybrid
- Note any monorepo structure: packages/, apps/, libs/, workspaces

**Step 2 — Identify entry points and bootstrapping:**
- Find main entry points: src/index.*, src/main.*, src/app.*, src/server.*, app/page.*, pages/_app.*, cmd/main.go
- Trace the startup sequence: what gets initialized, in what order
- Identify route/endpoint registration patterns

**Step 3 — Map architectural layers and boundaries:**
- Identify layers: presentation/UI, API/routes, business logic/services, data access/repositories, shared/utils
- For each layer, note: location, what it depends on, what depends on it
- Look for dependency injection patterns, factory functions, or service containers
- Check for clear boundaries (barrel exports, index files) vs tangled imports

**Step 4 — Trace key data flows:**
- Pick 2-3 representative flows (e.g., user request -> response, data write, async job)
- Trace through the layers: entry point -> middleware -> handler -> service -> data -> response
- Note where state is managed: in-memory, database, cache, session, URL, global store

**Step 5 — Identify abstractions and patterns:**
- Look for base classes, interfaces, generic types, decorators, HOCs, middleware chains
- Note design patterns in use: repository, factory, observer, strategy, command, pub/sub
- Check for shared utilities vs duplicated code
- Identify error handling strategy: try/catch, Result types, error boundaries, middleware error handlers
</exploration_guide>

Write these documents to .planning/codebase/:
- ARCHITECTURE.md — Pattern, layers, data flow, abstractions, entry points, error handling, cross-cutting concerns
- STRUCTURE.md — Directory layout, key locations, naming conventions, where to add new code

Use the document templates. Include file paths with backticks throughout. Return confirmation only."""
)
```

**Agent 3: Quality Focus**

```
Task(
  subagent_type="gsd-codebase-mapper",
  model="{mapper_model}",
  run_in_background=true,
  description="Map codebase conventions",
  prompt="""Focus: quality

Analyze this codebase for coding conventions and testing patterns.

<exploration_guide>
**Step 1 — Identify code style and formatting:**
- Read config files: .eslintrc*, eslint.config.*, .prettierrc*, biome.json, .editorconfig, rustfmt.toml, .clang-format, pyproject.toml [tool.black/ruff]
- Check for pre-commit hooks: .husky/, .pre-commit-config.yaml, lint-staged config in package.json
- Read 3-5 representative source files to observe actual conventions (not just config)

**Step 2 — Document naming conventions (with examples):**
- Files: kebab-case.ts, PascalCase.tsx, snake_case.py — pick 5+ real filenames as examples
- Functions/methods: camelCase, snake_case, PascalCase — pick 5+ real names
- Variables: camelCase, SCREAMING_SNAKE for constants
- Types/interfaces: PascalCase, I-prefix, T-prefix — note actual patterns used
- Components: PascalCase, default vs named exports

**Step 3 — Analyze import organization:**
- Read 5+ files and identify the import ordering pattern
- Note: external deps first? Then internal? Relative vs absolute? Path aliases (@/)?
- Check tsconfig.json paths, babel module-resolver, or similar for aliases

**Step 4 — Document error handling patterns:**
- Grep for try/catch, .catch, throw, Error classes, Result types
- Read 3+ error handling examples to identify the dominant pattern
- Note: custom error classes? Error codes? User-facing vs internal errors? Logging on catch?

**Step 5 — Map testing patterns thoroughly:**
- Find test runner config: jest.config.*, vitest.config.*, pytest.ini, .mocharc.*, bun test config in package.json
- Identify test file locations: co-located (*.test.ts next to source) or separate (__tests__/, tests/, spec/)
- Read 3-5 test files and document:
  - Suite organization: describe/it nesting, test naming conventions
  - Setup/teardown: beforeAll, beforeEach, fixtures, factories
  - Assertion style: expect().toBe, assert, chai, should
  - Mocking approach: jest.mock, vi.mock, sinon, manual stubs, dependency injection
  - What gets mocked (external services, DB) vs what runs real (business logic)
- Check for test utilities: custom render functions, test helpers, shared fixtures
- Note test types present: unit, integration, e2e (playwright/cypress), snapshot, contract
- Find coverage config and current thresholds
</exploration_guide>

Write these documents to .planning/codebase/:
- CONVENTIONS.md — Code style, naming, import organization, error handling, logging, function/module design
- TESTING.md — Framework, file organization, suite structure, mocking, fixtures, coverage, test types, common patterns

Use the document templates. Show ACTUAL code examples from the codebase in each section. Be prescriptive ("Use X pattern") not just descriptive ("X pattern exists"). Return confirmation only."""
)
```

**Agent 4: Concerns Focus**

```
Task(
  subagent_type="gsd-codebase-mapper",
  model="{mapper_model}",
  run_in_background=true,
  description="Map codebase concerns",
  prompt="""Focus: concerns

Analyze this codebase for technical debt, known issues, and areas of concern.

<exploration_guide>
**Step 1 — Find explicit debt markers:**
- Grep for: TODO, FIXME, HACK, XXX, WORKAROUND, TEMPORARY, @deprecated
- For each, note: file path, the comment text, and surrounding context (what code is affected)
- Categorize by severity: blocking (will break), degrading (getting worse), cosmetic (annoying but stable)

**Step 2 — Identify complexity hotspots:**
- Find the largest files (by line count) — these often contain the most complex logic
- Look for deeply nested code (4+ levels of indentation)
- Check for functions over 50 lines
- Look for files with many imports (high coupling)
- Identify god objects/modules that do too many things

**Step 3 — Assess security posture:**
- Check for: SQL injection risks (string concatenation in queries), XSS vectors (dangerouslySetInnerHTML, unsanitized output), hardcoded secrets, insecure defaults
- Note authentication/authorization gaps: missing auth checks on routes, no CSRF protection, no rate limiting
- Check dependency vulnerabilities: when was the lockfile last updated? Any known-vulnerable packages?
- Look for: eval(), exec(), child_process with user input, deserialization of untrusted data

**Step 4 — Find performance risks:**
- Look for: N+1 query patterns, missing pagination, unbounded loops, synchronous file I/O in request handlers
- Check for missing indexes (if schema files exist)
- Look for large synchronous operations that could block the event loop
- Identify missing caching opportunities

**Step 5 — Map fragile areas and test gaps:**
- Find code with no test coverage (grep for test files, compare against source files)
- Identify tightly coupled modules where a change in one breaks many others
- Look for implicit dependencies: global state, singleton patterns, order-dependent initialization
- Check for missing error handling: unhandled promise rejections, missing catch blocks, empty catch blocks
- Note any "magic" values, hardcoded config, or assumptions that could break in different environments

**Step 6 — Check dependency health:**
- Look for deprecated packages (check package.json comments, README warnings)
- Identify packages with no recent updates (potential abandonment)
- Note any forked or vendored dependencies
- Check for duplicate dependencies serving the same purpose
</exploration_guide>

Write this document to .planning/codebase/:
- CONCERNS.md — Tech debt, known bugs, security considerations, performance bottlenecks, fragile areas, scaling limits, dependency risks, missing features, test coverage gaps

Be specific and actionable. Every concern needs: file paths, impact assessment, and a fix approach. Prioritize by impact. Return confirmation only."""
)
```

Continue to collect_confirmations.
</step>

<step name="collect_confirmations" condition="Task tool is available">
Wait for all 4 agents to complete.

Read each agent's returned output to collect confirmations.

**Expected confirmation format from each agent:**
```
## Mapping Complete

**Focus:** {focus}
**Documents written:**
- `.planning/codebase/{DOC1}.md` ({N} lines)
- `.planning/codebase/{DOC2}.md` ({N} lines)

Ready for orchestrator summary.
```

**What you receive:** Just file paths and line counts. NOT document contents.

**Error handling:**
- If an agent fails entirely, log the failure and note which documents are missing
- If an agent writes partial output (one doc but not the other), keep what was written
- Do NOT re-run failed agents automatically -- note the failure for the user

Continue to verify_output.
</step>

<step name="sequential_mapping" condition="Task tool is NOT available (e.g., Antigravity, Gemini CLI, Codex)">

When the `Task` tool is unavailable, perform codebase mapping sequentially in the current context. This replaces `spawn_agents` and `collect_confirmations`.

**IMPORTANT:** Do NOT use `browser_subagent`, `Explore`, or any browser-based tool. Use only file system tools (Read, Bash, Write, Grep, Glob, list_dir, view_file, grep_search, or equivalent tools available in your runtime).

### Pass 1: Tech Focus

**Explore:**
- Read package manifests: package.json, requirements.txt, Cargo.toml, go.mod, pyproject.toml (whichever exist)
- Check version files: .nvmrc, .python-version, .tool-versions, rust-toolchain.toml
- Read framework configs: tsconfig.json, vite.config.*, next.config.*, tailwind.config.*
- Grep for SDK imports to find external integrations
- List .env files (existence only, NEVER read contents)
- Check for Dockerfile, CI config, deployment config

**Write:**
- `.planning/codebase/STACK.md` — Languages, runtime, frameworks, dependencies, configuration
- `.planning/codebase/INTEGRATIONS.md` — External APIs, databases, auth providers, webhooks, CI/CD

### Pass 2: Architecture Focus

**Explore:**
- List directory structure (excluding node_modules, .git, dist, build)
- Find and read entry points: src/index.*, src/main.*, src/app.*, src/server.*
- Read 5-10 source files to trace import patterns and layer boundaries
- Identify data flow through 2-3 representative request paths

**Write:**
- `.planning/codebase/ARCHITECTURE.md` — Pattern, layers, data flow, abstractions, entry points
- `.planning/codebase/STRUCTURE.md` — Directory layout, key locations, naming conventions, where to add new code

### Pass 3: Quality Focus

**Explore:**
- Read linting/formatting configs: .eslintrc*, .prettierrc*, biome.json, .editorconfig
- Read 3-5 representative source files for convention analysis
- Find and read test config: jest.config.*, vitest.config.*, or test runner in package.json
- Read 3-5 test files to document testing patterns, mocking, fixtures
- Check for pre-commit hooks in .husky/ or package.json

**Write:**
- `.planning/codebase/CONVENTIONS.md` — Code style, naming, import patterns, error handling, logging
- `.planning/codebase/TESTING.md` — Framework, structure, mocking, coverage, common patterns

### Pass 4: Concerns Focus

**Explore:**
- Grep for TODO, FIXME, HACK, XXX, WORKAROUND markers
- Find largest files by line count (complexity hotspots)
- Grep for security anti-patterns: eval, exec, dangerouslySetInnerHTML, string-concatenated queries
- Look for empty catch blocks, unhandled promise patterns
- Compare source files against test files to find coverage gaps
- Check for deprecated or stale dependencies

**Write:**
- `.planning/codebase/CONCERNS.md` — Tech debt, bugs, security, performance, fragile areas, scaling limits, dependency risks, test gaps

Use the document templates from the templates section. Include actual file paths with backticks throughout. Be prescriptive.

Continue to verify_output.

</step>

<step name="verify_output">
Verify all documents created successfully:

```bash
ls -la .planning/codebase/
wc -l .planning/codebase/*.md
```

**Verification checklist:**
- All 7 documents exist (or a known subset if running in Update mode)
- No empty documents (each should have >20 lines)
- Files are valid markdown (no truncated writes)

**If documents missing or empty:**
```
Warning: The following documents are missing or empty:
- [list missing/empty files]

This may indicate a mapper agent failure. You can:
1. Re-run mapping for the failed focus area: /gsd:map-codebase (then choose Update)
2. Continue with available documents
```

Continue to scan_for_secrets.
</step>

<step name="scan_for_secrets">
**CRITICAL SECURITY CHECK:** Scan output files for accidentally leaked secrets before committing.

Run secret pattern detection:

```bash
grep -rE '(sk-[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]+|sk_test_[a-zA-Z0-9]+|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]+|AKIA[A-Z0-9]{16}|xox[baprs]-[a-zA-Z0-9-]+|-----BEGIN.*PRIVATE KEY|eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.)' .planning/codebase/*.md 2>/dev/null && SECRETS_FOUND=true || SECRETS_FOUND=false
```

**If SECRETS_FOUND=true:**

```
SECURITY ALERT: Potential secrets detected in codebase documents!

Found patterns that look like API keys or tokens in:
[show grep output]

This would expose credentials if committed.

Action required:
1. Review the flagged content above
2. If these are real secrets, they must be removed before committing
3. Consider adding sensitive files to Claude Code "Deny" permissions

Pausing before commit. Reply "safe to proceed" if the flagged content is not actually sensitive, or edit the files first.
```

Wait for user confirmation before continuing to commit_codebase_map.

**If SECRETS_FOUND=false:**
Continue to commit_codebase_map.
</step>

<step name="commit_codebase_map">
Commit the codebase map (only if `commit_docs` is true from init context):

```bash
node "/home/joshuaduffill/.claude/get-shit-done/bin/gsd-tools.cjs" commit "docs: map existing codebase" --files .planning/codebase/*.md
```

If `commit_docs` is false, skip the commit and inform the user:
```
Codebase map written but not committed (commit_docs=false in config).
Run `git add .planning/codebase/ && git commit` to commit manually.
```

Continue to offer_next.
</step>

<step name="offer_next">
Present completion summary and next steps.

**Get line counts:**
```bash
wc -l .planning/codebase/*.md
```

**Output format:**

```
Codebase mapping complete.

Created .planning/codebase/:
- STACK.md ([N] lines) - Technologies and dependencies
- ARCHITECTURE.md ([N] lines) - System design and patterns
- STRUCTURE.md ([N] lines) - Directory layout and organization
- CONVENTIONS.md ([N] lines) - Code style and patterns
- TESTING.md ([N] lines) - Test structure and practices
- INTEGRATIONS.md ([N] lines) - External services and APIs
- CONCERNS.md ([N] lines) - Technical debt and issues


---

## Next Up

**Initialize project** -- use codebase context for planning

`/gsd:new-project`

`/clear` first for fresh context window

---

**Also available:**
- Re-run mapping: `/gsd:map-codebase`
- Review specific file: `cat .planning/codebase/STACK.md`
- Edit any document before proceeding

---
```

End workflow.
</step>

</process>

<templates>

### STACK.md Template (tech focus)

```markdown
# Technology Stack

**Analysis Date:** [YYYY-MM-DD]

## Languages

**Primary:**
- [Language] [Version] — [Where used, with file path examples]

**Secondary:**
- [Language] [Version] — [Where used]

## Runtime

**Environment:**
- [Runtime] [Version] (from [version file])

**Package Manager:**
- [Manager] [Version]
- Lockfile: `[lockfile path]` [present/missing]

## Frameworks

**Core:**
- [Framework] [Version] — [Purpose] (config: `[config file path]`)

**Testing:**
- [Framework] [Version] — [Purpose]

**Build/Dev:**
- [Tool] [Version] — [Purpose] (config: `[config file path]`)

## Key Dependencies

**Critical (app won't function without these):**
- `[package]` [Version] — [Why it matters] (used in `[file paths]`)

**Infrastructure:**
- `[package]` [Version] — [Purpose]

**Dev-only:**
- `[package]` [Version] — [Purpose]

## Configuration

**Environment:**
- [How env vars are loaded — e.g., "Bun auto-loads .env", "dotenv in src/config.ts"]
- Required env vars: [list var names, NOT values]

**Build:**
- `[config file]` — [What it configures]

**TypeScript/Compiler:**
- `[tsconfig.json path]` — [Key settings: target, module, strict mode]

## Platform Requirements

**Development:**
- [Runtime] >= [version]
- [Other requirements]

**Production:**
- [Deployment target]
- [Required services]

---

*Stack analysis: [date]*
```

### INTEGRATIONS.md Template (tech focus)

```markdown
# External Integrations

**Analysis Date:** [YYYY-MM-DD]

## APIs & External Services

### [Category — e.g., Payment, Email, Search]

**[Service Name]:**
- Purpose: [What it's used for]
- SDK/Client: `[package name]` (imported in `[file paths]`)
- Auth: `[ENV_VAR_NAME]` (type: API key / OAuth / token)
- Endpoints used: [list key endpoints or "SDK abstracts this"]

## Data Storage

### Databases
- **[Type/Provider]** (e.g., PostgreSQL via Supabase, SQLite via bun:sqlite)
  - Connection: `[ENV_VAR_NAME]`
  - Client/ORM: `[package]` (config: `[file path]`)
  - Schema: `[schema file path if applicable]`
  - Migrations: `[migration directory if applicable]`

### File Storage
- [Service or "Local filesystem only"]
  - Client: `[package]` (used in `[file paths]`)

### Caching
- [Service or "None"]
  - Client: `[package]`
  - Strategy: [cache-aside, write-through, TTL-based]

## Authentication & Identity

**Provider:** [Service or "Custom implementation"]
- Implementation: `[file paths]`
- Strategy: [JWT, session, OAuth, API keys]
- Session storage: [where sessions live]

## Monitoring & Observability

**Error Tracking:** [Service or "None"]
- Client: `[package]` (init in `[file path]`)

**Logging:** [Approach — structured JSON, console, external service]
- Library: `[package or "built-in console"]`
- Pattern: [where/how logging is done]

**Metrics:** [Service or "None"]

## CI/CD & Deployment

**Hosting:** [Platform]
- Config: `[deployment config file]`

**CI Pipeline:** [Service or "None"]
- Config: `[CI config file path]`
- Steps: [build, test, lint, deploy]

## Environment Configuration

**Required env vars (names only, never values):**
| Variable | Purpose | Required |
|----------|---------|----------|
| `[VAR_NAME]` | [Purpose] | Yes/No |

**Env file pattern:** [.env, .env.local, .env.production — note existence only]

## Webhooks & Callbacks

**Incoming:** [Endpoints that receive external callbacks, or "None"]
**Outgoing:** [External URLs the app calls on events, or "None"]

---

*Integration audit: [date]*
```

### ARCHITECTURE.md Template (arch focus)

```markdown
# Architecture

**Analysis Date:** [YYYY-MM-DD]

## Pattern Overview

**Overall:** [Pattern name — e.g., "Modular monolith", "MVC", "Hexagonal", "Serverless functions"]

**Key Characteristics:**
- [Characteristic 1 — e.g., "Single process, multi-module"]
- [Characteristic 2 — e.g., "Request-response with async background jobs"]
- [Characteristic 3 — e.g., "Shared database, no service boundaries"]

## Layers

### [Layer Name — e.g., "API / Routes"]
- **Purpose:** [What this layer does]
- **Location:** `[directory path]`
- **Contains:** [Types of code — handlers, controllers, route definitions]
- **Depends on:** [Which other layers it imports from]
- **Used by:** [What calls into this layer — external clients, other layers]
- **Key files:** `[2-3 most important files]`

### [Layer Name — e.g., "Business Logic / Services"]
- **Purpose:** [What this layer does]
- **Location:** `[directory path]`
- **Contains:** [Types of code]
- **Depends on:** [Data layer, external clients]
- **Used by:** [API layer, background jobs]

*(Repeat for each identified layer)*

## Data Flow

### [Flow Name — e.g., "User Request Lifecycle"]

```
[Entry point] -> [Middleware] -> [Handler] -> [Service] -> [Data access] -> [Response]
```

1. [Step 1 with file reference: "Request hits `src/server.ts` route handler"]
2. [Step 2: "Middleware in `src/middleware/auth.ts` validates token"]
3. [Step 3: "Handler calls service method in `src/services/user.ts`"]
4. [Step 4: "Service queries DB via `src/db/queries.ts`"]
5. [Step 5: "Response serialized and returned"]

**State Management:**
- [How state is handled — database, in-memory, cache, URL params, global store]

## Key Abstractions

### [Abstraction Name — e.g., "Base Service Pattern"]
- **Purpose:** [What it represents]
- **Examples:** `[file paths showing this pattern]`
- **Pattern:**
```typescript
[Show 5-15 lines of actual code demonstrating the pattern]
```

## Entry Points

### [Entry Point — e.g., "HTTP Server"]
- **Location:** `[file path]`
- **Triggers:** [What invokes it — CLI, HTTP request, cron, event]
- **Responsibilities:** [What it initializes and dispatches to]

### [Entry Point — e.g., "CLI Commands"]
- **Location:** `[file path]`
- **Triggers:** [Command line invocation]
- **Responsibilities:** [What it does]

## Error Handling

**Strategy:** [Overall approach — e.g., "Try/catch at handler level, custom error classes, HTTP error responses"]

**Patterns:**
- [Pattern 1 — e.g., "Custom AppError class in `src/errors.ts` with status codes"]
- [Pattern 2 — e.g., "Global error handler middleware catches unhandled errors"]
- [Pattern 3 — e.g., "Services throw, handlers catch and format response"]

```typescript
[Show actual error handling code example from codebase]
```

## Cross-Cutting Concerns

**Logging:** [Approach — e.g., "Structured JSON via pino, attached to request context"]
**Validation:** [Approach — e.g., "Zod schemas at API boundary in `src/schemas/`"]
**Authentication:** [Approach — e.g., "JWT middleware, role-based access in route config"]
**Configuration:** [Approach — e.g., "Environment variables loaded in `src/config.ts`"]

---

*Architecture analysis: [date]*
```

### STRUCTURE.md Template (arch focus)

```markdown
# Codebase Structure

**Analysis Date:** [YYYY-MM-DD]

## Directory Layout

```
[project-root]/
├── [dir]/              # [Purpose]
│   ├── [subdir]/       # [Purpose]
│   └── [subdir]/       # [Purpose]
├── [dir]/              # [Purpose]
├── [config-file]       # [Purpose]
└── [config-file]       # [Purpose]
```

## Directory Purposes

### `[directory-name]/`
- **Purpose:** [What lives here]
- **Contains:** [Types of files — components, services, utils]
- **Key files:**
  - `[file]` — [What it does]
  - `[file]` — [What it does]
- **Conventions:** [Any directory-specific patterns]

*(Repeat for each significant directory)*

## Key File Locations

**Entry Points:**
- `[path]` — [Purpose — e.g., "HTTP server startup"]
- `[path]` — [Purpose — e.g., "CLI entry point"]

**Configuration:**
- `[path]` — [Purpose — e.g., "TypeScript config"]
- `[path]` — [Purpose — e.g., "Build configuration"]

**Core Logic:**
- `[path]` — [Purpose — e.g., "Main business logic for X"]
- `[path]` — [Purpose — e.g., "Database operations"]

**Types/Interfaces:**
- `[path]` — [Purpose — e.g., "Shared type definitions"]

**Testing:**
- `[path]` — [Purpose — e.g., "Integration test suite"]
- `[path]` — [Purpose — e.g., "Test utilities/helpers"]

## Naming Conventions

**Files:**
- [Pattern]: [Example] — e.g., "kebab-case.ts: `user-service.ts`, `api-handler.ts`"
- [Pattern for components]: [Example] — e.g., "PascalCase.tsx: `UserProfile.tsx`"
- [Pattern for tests]: [Example] — e.g., "*.test.ts co-located: `broker.test.ts`"

**Directories:**
- [Pattern]: [Example] — e.g., "kebab-case: `shared/`, `gsd-plugin/`"

**Exports:**
- [Pattern] — e.g., "Named exports preferred, barrel files via index.ts"

## Where to Add New Code

**New feature / module:**
1. Primary code: `[path pattern]` — e.g., "`src/features/[feature-name].ts`"
2. Types: `[path pattern]` — e.g., "`shared/types.ts` (append to existing)"
3. Tests: `[path pattern]` — e.g., "`[feature-name].test.ts` co-located"

**New API endpoint / route:**
1. Handler: `[path pattern]`
2. Validation: `[path pattern]`
3. Tests: `[path pattern]`

**New utility / helper:**
- Shared: `[path]`
- Feature-specific: `[path pattern]`

**New configuration:**
- `[path]` — [Where config files go]

## Special Directories

### `[directory — e.g., node_modules/]`
- Purpose: [What it contains]
- Generated: Yes/No
- Committed: Yes/No
- Notes: [Any special considerations]

### `[directory — e.g., .planning/]`
- Purpose: [What it contains]
- Generated: Yes/No
- Committed: Yes/No

---

*Structure analysis: [date]*
```

### CONVENTIONS.md Template (quality focus)

```markdown
# Coding Conventions

**Analysis Date:** [YYYY-MM-DD]

## Naming Patterns

**Files:**
- [Pattern]: e.g., `kebab-case.ts` — examples: `[real filenames from codebase]`

**Functions:**
- [Pattern]: e.g., camelCase — examples: `[real function names]`
- [Async pattern]: e.g., same as sync, no prefix — examples: `[real names]`

**Variables:**
- [Local]: e.g., camelCase
- [Constants]: e.g., SCREAMING_SNAKE — examples: `[real names]`

**Types/Interfaces:**
- [Pattern]: e.g., PascalCase, no I-prefix — examples: `[real type names]`

**Components (if applicable):**
- [Pattern]: e.g., PascalCase — examples: `[real component names]`

## Code Style

**Formatting:**
- Tool: [prettier/biome/none]
- Config: `[config file path]`
- Key settings: [tab width, semicolons, quotes, trailing commas]

**Linting:**
- Tool: [eslint/biome/clippy/ruff]
- Config: `[config file path]`
- Key rules: [list non-default rules that matter]

**Line length:** [limit or "no enforced limit"]
**Semicolons:** [yes/no]
**Quotes:** [single/double]

## Import Organization

**Order (observed from codebase):**
1. [First group — e.g., "Node/Bun built-ins"]
2. [Second group — e.g., "External packages"]
3. [Third group — e.g., "Internal absolute imports"]
4. [Fourth group — e.g., "Relative imports"]

**Path Aliases:**
- `[alias]` -> `[actual path]` (configured in `[config file]`)

**Example (from actual codebase):**
```typescript
[Show a real import block from the codebase demonstrating the pattern]
```

## Error Handling

**Dominant pattern:**
```typescript
[Show actual error handling code from codebase — 5-15 lines]
```

**Custom error classes:** [Yes/No — if yes, show location and pattern]
**Error responses:** [How errors become API responses]
**Unhandled errors:** [Global handler location and behavior]

## Logging

**Framework:** [package or "console"]
**Pattern:**
```typescript
[Show actual logging example from codebase]
```
**When to log:** [Guidelines — e.g., "Log on error, log on external API calls, don't log in hot paths"]

## Comments

**When to comment:**
- [Observed guideline — e.g., "Only for non-obvious logic, not for self-documenting code"]

**JSDoc/TSDoc:**
- [Usage — e.g., "Used on exported functions only" or "Not used"]

## Function Design

**Size:** [Observed guideline — e.g., "Most functions under 30 lines"]
**Parameters:** [Pattern — e.g., "Options object for 3+ params"]
**Return values:** [Pattern — e.g., "Direct returns, no wrapper types"]
**Async:** [Pattern — e.g., "async/await preferred over .then chains"]

## Module Design

**Exports:** [Pattern — e.g., "Named exports, one module per file"]
**Barrel files:** [Used/Not used — if used, pattern]
**Circular dependency prevention:** [Strategy if any]

---

*Convention analysis: [date]*
```

### TESTING.md Template (quality focus)

```markdown
# Testing Patterns

**Analysis Date:** [YYYY-MM-DD]

## Test Framework

**Runner:**
- [Framework] [Version]
- Config: `[config file path]`

**Assertion Library:**
- [Library — e.g., "built-in expect from bun:test"]

**Run Commands:**
```bash
[command]              # Run all tests
[command]              # Run specific test file
[command]              # Watch mode (if available)
[command]              # Coverage (if configured)
```

## Test File Organization

**Location:** [Co-located with source / separate directory / both]
**Naming:** [Pattern — e.g., "`*.test.ts` co-located with source files"]

**Directory structure:**
```
[Show actual test file layout from codebase]
```

## Test Structure

**Suite organization (from actual codebase):**
```typescript
[Show a real test suite — 15-25 lines demonstrating describe/it nesting, setup, assertions]
```

**Naming convention for tests:**
- [Pattern — e.g., "describe('feature') > test('should do X when Y')"]

## Setup & Teardown

**Pattern (from actual codebase):**
```typescript
[Show actual beforeAll/beforeEach/afterAll pattern — including server setup, DB cleanup, etc.]
```

**Key considerations:**
- [e.g., "Tests share a broker instance started in beforeAll"]
- [e.g., "Each test gets its own peer registration"]

## Mocking

**Framework:** [jest.mock / vi.mock / manual / none]

**Patterns (from actual codebase):**
```typescript
[Show actual mocking example if present]
```

**What to mock:**
- [e.g., "External HTTP calls", "Time/dates"]

**What NOT to mock:**
- [e.g., "Database — use real SQLite", "Business logic"]

## Fixtures and Factories

**Test data pattern:**
```typescript
[Show how test data is created — inline, factory functions, fixture files]
```

**Location:** [Where fixtures/helpers live]

## Coverage

**Requirements:** [Target percentage or "None enforced"]
**Excluded:** [Directories/files excluded from coverage]

## Test Types Present

**Unit tests:**
- Scope: [What they test]
- Location: `[path pattern]`

**Integration tests:**
- Scope: [What they test — e.g., "Full HTTP request/response through broker"]
- Location: `[path pattern]`

**E2E tests:**
- [Framework or "Not present"]

## Common Patterns

**Async testing:**
```typescript
[Show actual async test pattern from codebase]
```

**Error case testing:**
```typescript
[Show how error cases are tested]
```

**HTTP endpoint testing (if applicable):**
```typescript
[Show how API endpoints are tested — request building, response assertions]
```

---

*Testing analysis: [date]*
```

### CONCERNS.md Template (concerns focus)

```markdown
# Codebase Concerns

**Analysis Date:** [YYYY-MM-DD]

## Tech Debt

### [Area/Component — e.g., "Error handling inconsistency"]
- **Issue:** [What's the shortcut/workaround — be specific]
- **Files:** `[file paths]`
- **Impact:** [What breaks or degrades — "New contributors add inconsistent error patterns"]
- **Fix approach:** [Concrete steps — "Create shared error handler in src/errors.ts, migrate callers"]
- **Priority:** High / Medium / Low

## Known Bugs

### [Bug description — e.g., "Race condition in peer cleanup"]
- **Symptoms:** [What the user sees]
- **Files:** `[file paths]`
- **Trigger:** [How to reproduce]
- **Workaround:** [If any — "Restart the broker"]
- **Priority:** High / Medium / Low

## Security Considerations

### [Area — e.g., "Input validation on API endpoints"]
- **Risk:** [What could go wrong — "Malformed JSON payload crashes broker"]
- **Files:** `[file paths]`
- **Current mitigation:** [What's in place]
- **Recommendation:** [What should be added — with specific approach]
- **Priority:** High / Medium / Low

## Performance Bottlenecks

### [Slow operation — e.g., "Full table scan on message poll"]
- **Problem:** [What's slow and when]
- **Files:** `[file paths]`
- **Cause:** [Root cause — "Missing index on (recipient, delivered) columns"]
- **Improvement:** [Specific fix — "Add partial index: CREATE INDEX ... WHERE delivered = 0"]
- **Priority:** High / Medium / Low

## Fragile Areas

### [Component — e.g., "Broker startup sequence"]
- **Files:** `[file paths]`
- **Why fragile:** [What makes it break — "Port conflict with no retry, PID file stale detection is racy"]
- **Safe modification guide:** [How to change safely — "Always test with concurrent broker starts"]
- **Test coverage:** [Current gaps — "No test for port-in-use scenario"]

## Scaling Limits

### [Resource — e.g., "SQLite single-writer"]
- **Current capacity:** [What works now — "Fine for <50 peers on one machine"]
- **Limit:** [Where it breaks — "Write contention above 100 concurrent peers"]
- **Scaling path:** [How to increase — "WAL mode helps; beyond that, switch to server DB"]

## Dependencies at Risk

### [Package — e.g., "unmaintained-lib v2.3"]
- **Risk:** [What's wrong — "No updates in 2 years, open CVE"]
- **Impact:** [What breaks if removed or breaks]
- **Migration plan:** [Alternative — "Replace with maintained-lib, API-compatible"]

## Missing Critical Features

### [Feature gap — e.g., "No graceful shutdown"]
- **Problem:** [What's missing — "Broker doesn't clean up peers on SIGTERM"]
- **Blocks:** [What can't be done — "Deployments leave stale peer records"]

## Test Coverage Gaps

### [Untested area — e.g., "Wave orchestration edge cases"]
- **What's not tested:** [Specific functionality — "Concurrent task-start with same files"]
- **Files:** `[file paths]`
- **Risk:** [What could break unnoticed — "File conflict detection may have false negatives"]
- **Priority:** High / Medium / Low

---

*Concerns audit: [date]*
```

</templates>

<success_criteria>
- .planning/codebase/ directory created
- If Task tool available: 4 parallel gsd-codebase-mapper agents spawned with run_in_background=true
- If Task tool NOT available: 4 sequential mapping passes performed inline (never using browser_subagent)
- All 7 codebase documents exist
- No empty documents (each should have >20 lines)
- Secret scan completed before any commit
- Clear completion summary with line counts
- User offered clear next steps in GSD style
</success_criteria>
