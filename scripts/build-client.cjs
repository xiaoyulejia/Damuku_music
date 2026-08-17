const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src', 'public');
const output = path.join(root, 'dist', 'public');
fs.mkdirSync(output, { recursive: true });
fs.cpSync(source, output, { recursive: true, force: true });
for (const file of fs.readdirSync(output, { recursive: true })) {
  if (file.endsWith('.ts')) fs.rmSync(path.join(output, file), { force: true });
}

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.client.build.json'], {
  cwd: root,
  stdio: 'inherit',
  shell: false
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// 浏览器现有源码仍通过 .mjs 引用解析器；发布目录用 TS 编译结果替换兼容文件，
// 因而构建产物实际执行的是 lyric-parser.ts，而无需在迁移期间改动页面协议。
const compiledParser = path.join(output, 'services', 'lyric-parser.js');
const publishedParser = path.join(output, 'services', 'lyric-parser.mjs');
fs.copyFileSync(compiledParser, publishedParser);
fs.rmSync(compiledParser, { force: true });
fs.rmSync(`${compiledParser}.map`, { force: true });
