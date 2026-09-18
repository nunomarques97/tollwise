// Configuration problems and their one-line, human-readable rendering.
//
//   tollwise.yaml:4:9: server.port: expected a whole number, got text "http". Fix: use a port between 1 and 65535.
//   environment TOLLWISE_PORT: "abc" is not a port number. Fix: set it to a whole number between 1 and 65535, or unset it.

import { redactText } from '../log/redact.ts';
import { escapeControlChars } from './network.ts';

export interface ConfigProblem {
  /** The file path as the user gave it, or `environment <NAME>` for environment variables. */
  readonly source: string;
  /** 1-based position in the file, when the problem has one. */
  readonly line?: number;
  readonly col?: number;
  /** Dotted field path such as `routing.timeouts.total_ms`; empty for whole-file problems. */
  readonly field: string;
  readonly message: string;
  /** What the user should do about it. */
  readonly hint: string;
}

/** Formats one problem as a single line. Key-shaped text is masked, whatever the message contains. */
export function formatProblem(problem: ConfigProblem): string {
  const source = escapeControlChars(problem.source);
  const where = problem.line !== undefined ? `${source}:${problem.line}:${problem.col ?? 1}` : source;
  const field = problem.field === '' ? '' : ` ${problem.field}:`;
  const message = oneLine(problem.message).replace(/\.$/, '');
  const hint = oneLine(problem.hint).replace(/\.$/, '');
  return redactText(`${where}:${field} ${message}. Fix: ${hint}${/[?!]$/.test(hint) ? '' : '.'}`);
}

/** Joins lines and escapes any remaining control character, so file content cannot drive the terminal. */
function oneLine(text: string): string {
  return escapeControlChars(text.replace(/\s*[\r\n]+\s*/g, ' ').trim());
}

/** Thrown by loadConfig() when the configuration cannot be used; carries every problem found. */
export class ConfigError extends Error {
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    const count = problems.length;
    super(
      `Invalid configuration (${count} problem${count === 1 ? '' : 's'}):\n${problems.map(formatProblem).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }

  /** One line per problem. */
  lines(): string[] {
    return this.problems.map(formatProblem);
  }
}
