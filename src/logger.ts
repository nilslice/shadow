const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

function timestamp(): string {
  return DIM + new Date().toLocaleTimeString() + RESET;
}

export const logger = {
  banner(projectRoot: string, scopeDir: string) {
    console.log();
    console.log(`${BOLD}shadow${RESET} ${DIM}v0.1.0${RESET}`);
    console.log(`${DIM}watching${RESET}  ${projectRoot}`);
    if (scopeDir !== projectRoot) {
      console.log(`${DIM}scope${RESET}     ${scopeDir}`);
    }
    console.log();
  },

  watching() {
    console.log(`${timestamp()} ${DIM}waiting for changes...${RESET}`);
  },

  trigger(changedFiles: string[]) {
    const count = changedFiles.length;
    const names = changedFiles.map((f) => f.split("/").pop()).join(", ");
    console.log();
    console.log(
      `${timestamp()} ${YELLOW}${count} file${count > 1 ? "s" : ""} changed${RESET} ${DIM}${names}${RESET}`,
    );
  },

  cascade(depth: number, changedFiles: string[]) {
    const names = changedFiles.map((f) => f.split("/").pop()).join(", ");
    console.log(
      `${timestamp()} ${YELLOW}cascade level ${depth}${RESET} ${DIM}checking ${names}${RESET}`,
    );
  },

  agentStart() {
    console.log(`${timestamp()} ${CYAN}analyzing...${RESET}`);
  },

  toolCall(toolName: string, filePath?: string) {
    if (filePath) {
      console.log(
        `${timestamp()} ${DIM}${toolName}${RESET} ${GREEN}${filePath}${RESET}`,
      );
    } else {
      console.log(`${timestamp()} ${DIM}${toolName}${RESET}`);
    }
  },

  fileWritten(filePath: string) {
    console.log(`${timestamp()} ${GREEN}+ ${filePath}${RESET}`);
  },

  done(durationMs: number, costUsd: number) {
    console.log(
      `${timestamp()} ${DIM}done${RESET} ${DIM}(${(durationMs / 1000).toFixed(1)}s, $${costUsd.toFixed(4)})${RESET}`,
    );
  },

  error(message: string) {
    console.error(`${timestamp()} ${RED}error${RESET} ${message}`);
  },

  warn(message: string) {
    console.warn(`${timestamp()} ${YELLOW}warn${RESET} ${message}`);
  },

  verbose(message: string) {
    console.log(`${timestamp()} ${DIM}${message}${RESET}`);
  },

  dryRunBanner() {
    console.log(`${YELLOW}${BOLD}DRY RUN MODE${RESET} ${DIM}-- no files will be written${RESET}`);
  },

  dryRunPreview(filePath: string, content: string, isNew: boolean) {
    console.log();
    console.log(
      `${timestamp()} ${YELLOW}[dry-run]${RESET} ${isNew ? GREEN + "+ " : CYAN + "~ "}${filePath}${RESET}`,
    );
    const lines = content.split("\n");
    const preview = lines.slice(0, 20);
    for (const line of preview) {
      console.log(`  ${DIM}${line}${RESET}`);
    }
    if (lines.length > 20) {
      console.log(`  ${DIM}... ${lines.length - 20} more lines${RESET}`);
    }
  },

  dryRunSummary(fileCount: number) {
    console.log();
    console.log(
      `${YELLOW}${BOLD}Dry run summary:${RESET} ${DIM}${fileCount} file(s) would be affected${RESET}`,
    );
  },

  parallelStart(groupCount: number) {
    console.log(
      `${timestamp()} ${CYAN}spawning ${groupCount} parallel agents${RESET}`,
    );
  },

  parallelDone(groupCount: number, filesWritten: number) {
    console.log(
      `${timestamp()} ${DIM}${groupCount} agents completed, ${filesWritten} file(s) written${RESET}`,
    );
  },
};

export const colors = { RESET, DIM, GREEN, YELLOW, RED, CYAN, BOLD };
