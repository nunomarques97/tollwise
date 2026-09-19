import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { describe, test } from 'node:test';
import { relayBody, type SseEvent, SseScanner, type SseScannerOptions } from '../src/proxy/sse.ts';

interface Seen {
  readonly name: string | undefined;
  readonly data: string;
}

/** Feeds `input` to a scanner in pieces of `size` bytes; returns what it forwarded and the events it saw. */
function run(
  input: Buffer,
  size: number,
  options: Partial<SseScannerOptions> & { readonly drop?: (event: SseEvent) => boolean } = {},
): { readonly output: Buffer; readonly events: Seen[]; readonly outputs: Buffer[] } {
  const events: Seen[] = [];
  const scanner = new SseScanner({
    ...options,
    onEvent: (event) => {
      events.push({ name: event.name, data: event.data.toString('utf8') });
      return options.drop?.(event) === true ? 'drop' : 'forward';
    },
  });
  const outputs: Buffer[] = [];
  for (let at = 0; at < input.length; at += size) scanner.scan(input.subarray(at, at + size), outputs);
  scanner.end(outputs);
  return { output: Buffer.concat(outputs), events, outputs };
}

const STREAM = Buffer.from(
  ': keep-alive comment\n\n' +
    'data: {"n":1}\n\n' +
    'event: message_delta\r\ndata:{"n":2}\r\n\r\n' +
    'data: {"first":true}\ndata: {"second":true}\nid: 7\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":1}}\n\n' +
    'data: [DONE]\n\n',
);

const EXPECTED_EVENTS: Seen[] = [
  { name: undefined, data: '{"n":1}' },
  { name: 'message_delta', data: '{"n":2}' },
  { name: undefined, data: '{"first":true}\n{"second":true}' },
  { name: undefined, data: '{"choices":[],"usage":{"prompt_tokens":1}}' },
  { name: undefined, data: '[DONE]' },
];

describe('SseScanner in passthrough mode', () => {
  test('forwards every chunk unchanged, at once, and reads the same events whatever the chunk size', () => {
    for (let size = 1; size <= STREAM.length; size += 1) {
      const result = run(STREAM, size);
      assert.ok(result.output.equals(STREAM), `chunk size ${size}`);
      assert.deepEqual(result.events, EXPECTED_EVENTS, `chunk size ${size}`);
    }
  });

  test('hands back the very chunk objects it was given (no copy, no re-serialisation)', () => {
    const scanner = new SseScanner({ onEvent: () => 'drop' });
    const chunk = Buffer.from('data: {"a":1}\n\n');
    const out: Buffer[] = [];
    scanner.scan(chunk, out);
    assert.equal(out.length, 1);
    assert.equal(out[0], chunk);
  });

  test('a drop verdict is ignored: passthrough never removes bytes', () => {
    const result = run(STREAM, 7, { drop: () => true });
    assert.ok(result.output.equals(STREAM));
  });
});

describe('SseScanner in hold mode', () => {
  const isUsage = (event: SseEvent): boolean => event.data.includes('"usage"');
  const withoutUsage = Buffer.from(
    STREAM.toString('utf8').replace('data: {"choices":[],"usage":{"prompt_tokens":1}}\n\n', ''),
  );

  test('removes exactly the dropped event, whatever the chunk size', () => {
    for (let size = 1; size <= STREAM.length; size += 1) {
      const result = run(STREAM, size, { hold: true, drop: isUsage });
      assert.equal(result.output.toString('utf8'), withoutUsage.toString('utf8'), `chunk size ${size}`);
      assert.deepEqual(result.events, EXPECTED_EVENTS, `chunk size ${size}`);
    }
  });

  test('forwards a whole event as soon as its blank line arrives', () => {
    const scanner = new SseScanner({ hold: true, onEvent: () => 'forward' });
    const out: Buffer[] = [];
    scanner.scan(Buffer.from('data: {"a":1}\n'), out);
    assert.equal(out.length, 0, 'held until the event ends');
    scanner.scan(Buffer.from('\ndata: {"b"'), out);
    assert.equal(Buffer.concat(out).toString('utf8'), 'data: {"a":1}\n\n');
  });

  test('an unfinished last event is forwarded as is at the end of the stream', () => {
    const input = Buffer.from('data: {"a":1}\n\ndata: {"cut');
    const result = run(input, 4, { hold: true, drop: () => true });
    assert.equal(result.output.toString('utf8'), 'data: {"cut');
  });
});

describe('SseScanner bounds', () => {
  const MAX = 1024;

  test('a line far longer than the cap is never buffered or read, and its bytes all pass', () => {
    const huge = Buffer.alloc(200 * MAX, 0x61);
    const input = Buffer.concat([Buffer.from('data: '), huge, Buffer.from('\n\ndata: {"after":1}\n\n')]);
    for (const hold of [false, true]) {
      const events: string[] = [];
      const scanner = new SseScanner({
        hold,
        maxEventBytes: MAX,
        onEvent: (event) => {
          events.push(event.data.toString('utf8'));
          return 'drop';
        },
      });
      const out: Buffer[] = [];
      let peak = 0;
      for (let at = 0; at < input.length; at += 100) {
        scanner.scan(input.subarray(at, at + 100), out);
        peak = Math.max(peak, scanner.bufferedBytes);
      }
      scanner.end(out);
      assert.ok(peak <= 2 * MAX, `hold=${hold}: at most ${2 * MAX} bytes kept, saw ${peak}`);
      assert.deepEqual(events, ['{"after":1}'], `hold=${hold}: the huge event is not read`);
      const expected = hold ? input.subarray(0, input.length - 'data: {"after":1}\n\n'.length) : input;
      assert.ok(Buffer.concat(out).equals(expected), `hold=${hold}: every byte of the huge event is forwarded`);
    }
  });

  test('many data lines adding up past the cap make the event unreadable, not a growing buffer', () => {
    const line = `data: ${'b'.repeat(100)}\n`;
    const input = Buffer.from(`${line.repeat(50)}\ndata: {"ok":1}\n\n`);
    const result = run(input, 64, { maxEventBytes: MAX });
    assert.deepEqual(
      result.events.map((event) => event.data),
      ['{"ok":1}'],
    );
  });

  test('work is linear in the input: 16 MiB without a newline, in 512-byte chunks, is fast', () => {
    const scanner = new SseScanner({ onEvent: () => 'forward' });
    const chunk = Buffer.alloc(512, 0x78);
    const out: Buffer[] = [];
    const started = performance.now();
    scanner.scan(Buffer.from('data: '), out);
    for (let sent = 0; sent < 16 * 1024 * 1024; sent += chunk.length) {
      scanner.scan(chunk, out);
      out.length = 0;
    }
    const elapsed = performance.now() - started;
    assert.ok(scanner.bufferedBytes <= 256 * 1024);
    assert.ok(elapsed < 1500, `took ${elapsed.toFixed(0)} ms`);
  });
});

describe('relayBody', () => {
  test('writes every forwarded byte in order through a slow destination (backpressure)', async () => {
    const input = Buffer.from('data: {"a":1}\n\n'.repeat(2000));
    const received: Buffer[] = [];
    const destination = new Writable({
      highWaterMark: 64,
      write(chunk: Buffer, _encoding, callback) {
        received.push(chunk);
        setImmediate(callback);
      },
    });
    const pieces: Buffer[] = [];
    for (let at = 0; at < input.length; at += 1000) pieces.push(input.subarray(at, at + 1000));
    await relayBody(
      Readable.from(pieces),
      destination,
      new SseScanner({ hold: true, onEvent: () => 'forward' }),
      new AbortController().signal,
    );
    assert.ok(Buffer.concat(received).equals(input));
  });

  test('rejects when the source fails', async () => {
    const source = new Readable({ read() {} });
    source.push(Buffer.from('data: {"a":1}\n\n'));
    setImmediate(() => source.destroy(new Error('upstream gone')));
    const destination = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    await assert.rejects(
      relayBody(source, destination, new SseScanner({ onEvent: () => 'forward' }), new AbortController().signal),
      /upstream gone/,
    );
  });
});
