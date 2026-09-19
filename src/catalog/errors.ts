// Catalog problems and their one-line, human-readable rendering.
//
//   catalog/models.yaml: models[3] (openai/gpt-6-astra): price.input: must not be negative
//   catalog/models.yaml: models[7]: source_url: is required

export interface CatalogProblem {
  /** The file path (or other source label) the catalog was read from. */
  readonly source: string;
  /** Which entry the problem is in, e.g. `models[3]` or `models[3] (openai/gpt-6-astra)`. */
  readonly entry: string;
  /** Dotted field path inside the entry, e.g. `price.input`; empty for whole-entry problems. */
  readonly field: string;
  readonly message: string;
}

/** Formats one problem as a single line. */
export function formatCatalogProblem(problem: CatalogProblem): string {
  const field = problem.field === '' ? '' : ` ${problem.field}:`;
  return `${problem.source}: ${problem.entry}:${field} ${problem.message}`;
}

/** Thrown when the catalog cannot be used; carries every problem found. */
export class CatalogError extends Error {
  readonly problems: readonly CatalogProblem[];

  constructor(problems: readonly CatalogProblem[]) {
    const count = problems.length;
    super(
      `Invalid catalog (${count} problem${count === 1 ? '' : 's'}):\n${problems.map(formatCatalogProblem).join('\n')}`,
    );
    this.name = 'CatalogError';
    this.problems = problems;
  }

  /** One line per problem. */
  lines(): string[] {
    return this.problems.map(formatCatalogProblem);
  }
}
