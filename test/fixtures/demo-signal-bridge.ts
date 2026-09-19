// Test-only launcher for scripts/demo.ts, used where a parent process cannot deliver a real signal to
// a child's handlers (on Windows, ChildProcess.kill() always terminates the child abruptly). It runs
// the demo script in this process and turns an IPC message ('SIGINT' or 'SIGTERM') into that signal
// event on `process`, so the script's own signal handlers run exactly as they would for a real signal.
// See test/fixtures/signal-bridge.ts for the same pattern used by the CLI's own tests.

process.channel?.unref();
process.on('message', (message: unknown) => {
  if (message !== 'SIGINT' && message !== 'SIGTERM') return;
  process.disconnect?.();
  process.emit(message);
});

await import('../../scripts/demo.ts');
