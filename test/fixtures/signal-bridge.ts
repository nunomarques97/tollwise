// Test-only launcher for the CLI, used where a parent process cannot deliver a real signal to a child's
// handlers (on Windows, ChildProcess.kill() always terminates the child abruptly). It runs the real CLI in
// this process and turns an IPC message ('SIGINT' or 'SIGTERM') into that signal event on `process`, so
// the CLI's own signal handlers run exactly as they would for a real signal.

process.channel?.unref();
process.on('message', (message: unknown) => {
  if (message !== 'SIGINT' && message !== 'SIGTERM') return;
  process.disconnect?.();
  process.emit(message);
});

await import('../../src/cli.ts');
