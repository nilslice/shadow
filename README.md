# shadow

*A file-watching coding agent that lets you import things before they exist.*

Write the call sites and imports first — shadow fills in the implementations concurrently using the Claude Agent SDK, so your types resolve and your LSP updates in real time. Language-agnostic code generation, written in TypeScript, runs on Bun.

## How it works

1. You run `shadow` in your project directory.
2. You write code that references types, functions, or modules that don't exist yet.
3. On save, shadow detects unresolved imports, invokes a Claude agent, and generates the missing files at the paths your code expects.
4. Your editor picks up the new files and the type errors disappear.

shadow only creates or updates implementation files that your code imports. The one exception is type-hole filling: if you write `// TODO` or `throw new Error("not implemented")`, shadow fills in the stub directly.

## Quick start

```sh
npm install -g @nilslice/shadow
```

Or, clone and run from the project root:

```
bun install
bun src/index.ts
```

Or with arguments:

```
bun src/index.ts /path/to/project --verbose
```

On first run, shadow checks for credentials in this order:

1. `ANTHROPIC_API_KEY` environment variable
2. Stored credentials in `~/.shadow/credentials.json`
3. Existing Claude Code API key in the macOS Keychain
4. Interactive setup (OAuth login or manual API key entry)

## CLI

```
shadow [project-root] [options]
```

- `project-root` -- Directory to watch. Defaults to the current working directory.
- `--scope <dir>` -- Restrict the agent's write access to this directory. Defaults to the project root.
- `--debounce <ms>` -- Milliseconds to wait after the last file change before triggering the agent. Default: 1500.
- `--verbose`, `-v` -- Print agent reasoning, tool calls, and session details.
- `--dry-run` -- Preview what shadow would generate without writing any files.
- `--parallel [n]` -- Run up to `n` agents concurrently for independent work (default: 3 when flag is present).
- `--help`, `-h` -- Show usage information.

## Building

Compile to a standalone binary:

```
bun run build
```

This produces a `shadow` executable in the project root.

## Project structure

```
src/
  index.ts      CLI entry point, argument parsing, watcher/agent orchestration
  auth.ts       Credential detection and OAuth PKCE authentication flow
  agent.ts      Claude Agent SDK session management and message handling
  watcher.ts    File system watcher with debounce and feedback loop prevention
  filter.ts     Pre-filter: import resolution + type-hole detection
  scope.ts      PreToolUse hook that enforces write boundaries
  prompt.ts     System prompt and per-trigger prompt construction with diffing
  parallel.ts   Work partitioning for parallel agent execution
  logger.ts     Colored terminal output
```

### auth.ts

Handles authentication with Anthropic. Supports four methods:

- OAuth PKCE flow against `claude.ai` (Pro/Max subscriptions) or `console.anthropic.com` (API key billing)
- Manual API key entry, stored in `~/.shadow/credentials.json`
- Automatic detection of existing Claude Code credentials from the macOS Keychain
- Cloud provider environment variables (Bedrock, Vertex, Azure)

OAuth tokens are automatically refreshed on expiry.

### filter.ts

Two pre-flight checks run before the agent is invoked:

1. **Import resolution** -- parses import statements from changed files and checks whether the referenced paths exist on disk. If all imports resolve, the agent is not called. Supports TypeScript/JavaScript, Python, Go, and Rust import patterns.
2. **Type-hole detection** -- scans for `// TODO`, `// FIXME`, `throw new Error("not implemented")`, and language-specific stubs (`todo!()` in Rust, `raise NotImplementedError` in Python, `panic("not implemented")` in Go). Files with holes are passed to the agent for filling.

### agent.ts

Wraps the Claude Agent SDK `query()` function. Maintains a session ID across triggers so the agent remembers what it previously generated and can update files rather than recreating them. Registers hooks for scope enforcement and write tracking.

### scope.ts

A `PreToolUse` hook that runs before every `Write` or `Edit` tool call. Denies writes outside the scope boundary and blocks modifications to the user's source files (the files that triggered the run). Files with detected type holes are exempted from the trigger-file protection so the agent can fill in their stubs.

### prompt.ts

Constructs the prompt sent to the agent on each trigger. Includes file contents (or diffs for large files seen before) and hints about which specific imports are unresolved. Caches file contents between triggers to enable diff-based prompts.

### watcher.ts

Uses `node:fs` `watch()` with recursive mode. Accumulates file changes into a set and fires the callback after a configurable debounce period. Tracks recently written files to prevent feedback loops where the agent's own output re-triggers a run.

### parallel.ts

Partitions unresolved imports and type holes into independent work groups for concurrent execution. Groups hints by source file directory -- hints in the same directory are likely related and run together. Small workloads (two or fewer hints) stay serial.

## Features

### Cascade triggers

When shadow generates a file that itself has unresolved imports, it automatically chains another generation pass without waiting for a user save. This resolves full dependency trees in one burst. Cascading is capped at three levels to prevent runaway generation.

### Type-hole filling

Beyond missing imports, shadow detects stubs in your code and fills them in:

- `// TODO` and `// FIXME` comments
- `throw new Error("not implemented")`
- Language-specific patterns: `todo!()` / `unimplemented!()` in Rust, `raise NotImplementedError` in Python, `panic("not implemented")` in Go

The agent edits only the marked sections and leaves the rest of the file untouched.

### Dry run mode

`shadow --dry-run` runs the agent and shows what it would generate without writing anything to disk. The agent's writes are captured, previewed in the terminal, then reverted. Useful for building trust or inspecting the agent's reasoning before letting it loose.

### Parallel agents

`shadow --parallel` spins up multiple agent sessions when unresolved imports target independent files. Each worker agent handles a partition of the work concurrently, reducing wall-clock time for projects with many missing implementations.

## Cost optimization

shadow minimizes token usage through several mechanisms:

- **Pre-filtering**: Import resolution checks happen locally before any API call. Saves that don't introduce new unresolved references cost zero tokens.
- **Diff-based prompts**: For files seen in a previous trigger, only the diff is sent rather than the full file contents.
- **Unresolved hints**: The prompt tells the agent exactly which imports are missing, reducing exploratory tool calls.
- **Session resumption**: The agent maintains context across triggers, avoiding redundant project exploration.
- **Prompt caching**: The system prompt is identical across triggers, benefiting from Anthropic's automatic prompt caching.

## Language support

shadow is language-agnostic. The agent determines output paths and implementation patterns from your code's imports and the project's existing conventions. The pre-filter currently parses import patterns for:

- TypeScript / JavaScript (`import`, `require`, `export from`)
- Python (`import`, `from ... import`)
- Go (`import`)
- Rust (`use crate::`, `mod`)

For other languages, the pre-filter is bypassed and the agent handles analysis directly.

## Contributing

The project uses Bun as its runtime and build tool. To get started:

```
git clone https://github.com/nilslice/shadow.git
cd shadow
bun install
```

Run the development watcher (restarts on source changes):

```
bun run dev
```

Type-check without emitting:

```
bun run typecheck
```

### Guidelines

- Keep dependencies minimal. The only runtime dependency is `@anthropic-ai/claude-agent-sdk`.
- The pre-filter (`filter.ts`) is the first place to add support for new languages.
- Hooks in `scope.ts` are the safety boundary. Changes here should be conservative.
- Test changes by running `shadow` against a sample project with unresolved imports and verifying that the agent generates correct implementations without modifying user files.
