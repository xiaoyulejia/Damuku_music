const { spawnSync } = require('node:child_process');
const path = require('node:path');

const tsc = path.join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.server.build.json'], {
  stdio: 'inherit',
  shell: false
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
