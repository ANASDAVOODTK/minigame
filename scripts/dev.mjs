// Starts the local stack: `wrangler dev` (Worker + Durable Objects on :8787)
// and the Vite dev server (:5173, proxies /api to :8787). Ctrl+C stops both.
import { spawn } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';

if (!existsSync('worker/.dev.vars')) {
  copyFileSync('worker/.dev.vars.example', 'worker/.dev.vars');
  console.log('[dev] created worker/.dev.vars from .dev.vars.example');
}

const procs = [
  { name: 'worker', color: '\x1b[35m', cmd: 'npm', args: ['run', 'dev', '-w', 'worker'] },
  { name: 'client', color: '\x1b[36m', cmd: 'npm', args: ['run', 'dev', '-w', 'client'] },
].map(({ name, color, cmd, args }) => {
  const p = spawn(cmd, args, { shell: true, env: { ...process.env, FORCE_COLOR: '1' } });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on('data', (d) =>
      String(d)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => out.write(prefix + line + '\n')),
    );
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${prefix}exited (${code})`);
    shutdown();
  });
  return p;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) {
    if (p.exitCode === null) {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']);
      else p.kill('SIGINT');
    }
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
