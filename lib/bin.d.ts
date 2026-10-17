//#region src/bin.d.ts
/**
 * The plugin's command line: `status`, `doctor`, `logout`.
 *
 * Reached through the harness rather than directly, so it runs inside the
 * profile's dependency closure:
 *
 * ```
 * dsh plugin --profile web exec dsh-raccoon-connect status
 * ```
 *
 * which is the harness forwarding `exec …` to `pnpm exec` in the profile
 * directory. That matters for one reason: this file must not import cordis or
 * any harness service. It is a plain node script, and the moment it needs a
 * running host it stops being able to answer "why is the provider not showing up"
 * in exactly the situation where the host is broken.
 *
 * Both read-only commands deliberately use `store.current()` and never
 * `resolve()`. Refreshing a 小浣熊 token rotates a *single-use* refresh token and
 * writes the pair back to the desktop app's file; a command someone typed to
 * "just look" must not be the thing that changes their sign-in state.
 */
/** Machine-readable status output. */
interface RaccoonCliStatus {
  pluginVersion: string;
  provider: string;
  state: 'signed-in' | 'signed-out';
  reason?: string;
  nickname?: string;
  identity?: string;
  orgName?: string;
  source?: 'desktop' | 'dsh';
  expiresAt?: number;
  refreshExpiresAt?: number;
  expiresInSec?: number;
  desktopAuthPath: string;
  desktopFilePresent: boolean;
  ownAuthPath: string;
  host: 'running' | 'stale' | 'not-started';
  points?: {
    total?: number;
    plan?: string;
    note?: string;
  };
  pointsError?: string;
  /** Anything the message would otherwise leak into a terminal scrollback. */
  notes: string[];
}
/** A recognized command line. */
interface RaccoonCliArgs {
  command: 'status' | 'doctor' | 'logout' | 'help';
  json: boolean;
  provider: string;
}
/** What {@link run} returns: an exit code plus the lines it printed. */
interface RaccoonCliResult {
  code: number;
  lines: string[];
  status?: RaccoonCliStatus;
}
/** Strip anything shaped like a token from a message before it reaches a terminal. */
declare function safeMessage(value: string): string;
/** Parse argv. Unknown flags are reported rather than ignored. */
declare function parseArgs(argv: readonly string[]): RaccoonCliArgs | {
  error: string;
};
/**
 * Collect everything the read-only commands report.
 *
 * Never refreshes, never spends a request unless the user asked for `status`
 * (which reads the balance) and the token is still live.
 */
declare function collectStatus(provider: string, options?: {
  withPoints?: boolean;
}): Promise<RaccoonCliStatus>;
/** Human-readable rendering of a collected status. */
declare function renderStatus(status: RaccoonCliStatus): string[];
/** Extra `doctor` output: paths, heartbeat contents, roster size, probe cache. */
declare function renderDoctor(status: RaccoonCliStatus): string[];
/** Usage text, printed by `help` and on any parse error. */
declare function usage(): string[];
/**
 * Run the CLI.
 *
 * @param argv - arguments after the command name.
 * @param output - injected so tests (and a future JSON-only caller) capture lines
 *   instead of watching a process write to a terminal.
 */
declare function run(argv: readonly string[], output?: {
  log: (line: string) => void;
  error: (line: string) => void;
}): Promise<number>;
//#endregion
export { RaccoonCliArgs, RaccoonCliResult, RaccoonCliStatus, collectStatus, parseArgs, renderDoctor, renderStatus, run, safeMessage, usage };