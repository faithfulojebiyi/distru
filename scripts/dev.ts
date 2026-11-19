// Starts the whole local stack with one command: every app's `dev` script (agent, web, Distru mock,
// Headset mock, emulators) plus the Inngest dev server. Ctrl+C stops everything.
const procs = [
  Bun.spawn(['bun', 'run', '--filter', './apps/*', 'dev'], { stdout: 'inherit', stderr: 'inherit' }),
  // npx directly: `bun run` rewrites npx to `bun x`, which skips the install script that downloads the CLI binary.
  Bun.spawn(
    ['npx', '--yes', '--ignore-scripts=false', 'inngest-cli@latest', 'dev', '-u', 'http://localhost:4111/api/inngest', '--no-discovery'],
    { stdout: 'inherit', stderr: 'inherit' },
  ),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(`
  Ops Agent is starting:
    dashboard        http://localhost:3050   (sign in as Operator or Approver)
    agent server     http://localhost:4111
    Inngest          http://localhost:8288
    Distru mock      http://localhost:4500
    Headset mock     http://localhost:4600
    emulators        http://localhost:4700
`);

await Promise.all(procs.map((p) => p.exited));
