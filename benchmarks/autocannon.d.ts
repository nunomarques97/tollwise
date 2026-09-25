// Minimal ambient types for the one autocannon entry point this benchmark uses. autocannon ships no
// type declarations of its own, and this project has not added a community `@types/autocannon`
// package, so this hand-written declaration covers only the options and result fields actually read
// by benchmarks/overhead.ts -- never a full copy of autocannon's API surface.

declare module 'autocannon' {
  export interface Options {
    readonly url: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly connections?: number;
    readonly duration?: number;
  }

  export interface LatencyStats {
    readonly p50: number;
    readonly p99: number;
  }

  export interface Result {
    readonly latency: LatencyStats;
    readonly errors: number;
    readonly timeouts: number;
    readonly non2xx: number;
    readonly duration: number;
  }

  /** Runs one load test to completion and resolves with its aggregated result. */
  export default function autocannon(options: Options): Promise<Result>;
}
