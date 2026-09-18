// Minimal HTTP client for tests against a server on this machine (node:http, no connection reuse).

import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer } from 'node:net';

export interface TestResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  /** The body parsed as JSON; undefined when it is not JSON. */
  readonly json: unknown;
}

export interface TestRequest {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Sends one request and reads the whole response. */
export function send(baseUrl: string, path: string, options: TestRequest = {}): Promise<TestResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: options.method ?? 'GET',
        headers: { connection: 'close', ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** A TCP port that was free a moment ago on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
