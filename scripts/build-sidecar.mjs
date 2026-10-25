#!/usr/bin/env node
// 编译本地服务为单文件 sidecar（bun --compile，零原生模块），产物落在 Tauri
// externalBin 约定路径：apps/desktop/src-tauri/binaries/noidle-server-<rust-triple>[.exe]。
// 默认编当前平台；--windows 从 mac/linux 交叉编译出 Windows exe（bun 原生支持）。
// 构建顺序依赖：需先 npm run build 产出 apps/web/dist（sidecar 运行时托管，与壳共用）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'apps/desktop/src-tauri/binaries');
const entry = path.join(root, 'apps/server/src/index.ts');

const wantWindows = process.argv.slice(2).includes('--windows');
const hostTriple =
  process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin'
    : process.platform === 'win32'
      ? process.arch === 'arm64'
        ? 'aarch64-pc-windows-msvc'
        : 'x86_64-pc-windows-msvc'
      : process.arch === 'arm64'
        ? 'aarch64-unknown-linux-gnu'
        : 'x86_64-unknown-linux-gnu';

const triple = wantWindows ? 'x86_64-pc-windows-msvc' : hostTriple;
const ext = triple.includes('windows') ? '.exe' : '';
const outfile = path.join(outDir, `noidle-server-${triple}${ext}`);

const cmd = ['build', '--compile', '--minify'];
if (wantWindows) cmd.push('--target=bun-windows-x64');
cmd.push(entry, `--outfile=${outfile}`);

fs.mkdirSync(outDir, { recursive: true });
console.log(`[build-sidecar] bun ${cmd.join(' ')}`);
execFileSync('bun', cmd, { stdio: 'inherit', cwd: root });
console.log(`[build-sidecar] 产出: ${outfile}`);
