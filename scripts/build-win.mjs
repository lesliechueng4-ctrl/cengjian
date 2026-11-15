// Builds the Windows no-install package: the app, the Node runtime that is
// running this script, and a start.bat, zipped into dist/.
//
//   npm run build:win
//
// The person who gets the zip unpacks it and double-clicks start.bat. They do
// not need Node, npm or anything else. Demucs and FFmpeg are not included, so
// the package separates in the browser and exports video by browser recording
// unless those are installed on that computer.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const PACKAGE_DIR = 'chaipai-win-x64';
/** What goes into the package's app/ folder, relative to the repository root. */
export const APP_FILES = ['server.js', 'server-util.js', 'demucs-service.js', 'export-service.js', 'package.json', 'LICENSE', 'public'];

const CRLF = (lines) => lines.join('\r\n') + '\r\n';

/** start.bat for the package: uses the bundled Node and opens the browser. */
export function startBat() {
  return CRLF([
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0app"',
    '',
    'rem 已经在运行（5173 端口被占用）时不再启动第二个，直接打开网页',
    'netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul',
    'if not errorlevel 1 (',
    '  echo 拆拍已经在运行，正在打开网页 http://localhost:5173',
    '  start "" http://localhost:5173',
    '  timeout /t 4 >nul',
    '  exit /b',
    ')',
    '',
    'echo 正在启动 拆拍 音乐练习 ...',
    'echo 用的时候不要关这个窗口，关掉它 app 就停了。',
    'rem 等 2 秒让服务器起来，再打开网页',
    'start "" /min cmd /c "timeout /t 2 >nul & start http://localhost:5173"',
    '"%~dp0node\\node.exe" server.js',
    'pause',
  ]);
}

/** README.txt for the package (UTF-8 with BOM so Notepad shows the Chinese text). */
export function readmeTxt({ version, nodeVersion }) {
  return '﻿' + CRLF([
    `拆拍 · 音乐练习  ${version}`,
    '',
    '怎么用',
    '  1. 把整个文件夹解压到任意位置（不要只解压其中一个文件）。',
    '  2. 双击 start.bat。会出现一个黑色窗口，并自动打开浏览器。',
    '  3. 浏览器里上传一段视频或一首歌就可以开始练了。',
    '  4. 用完把黑色窗口关掉。',
    '',
    '  如果浏览器没有自动打开，手动访问 http://localhost:5173',
    '  第一次启动时 Windows 可能弹出防火墙提示：只在这台电脑上用可以点“取消”；',
    '  想让同一 Wi-Fi 下的手机也能打开，点“允许”，然后用黑色窗口里显示的“手机访问”地址。',
    '',
    '说明',
    '  - 不需要安装任何东西，文件夹里自带运行环境。',
    '  - 你的文件只在这台电脑上处理，不会上传到别处。',
    '  - 这个包用浏览器自带的算法分离音轨。想要更准的 AI 分离（Demucs）和更快的视频导出（FFmpeg），',
    '    需要另外安装，方法见 app 文件夹里的 README.md。',
    '',
    `自带的运行环境：Node.js ${nodeVersion}（MIT 许可证，https://nodejs.org）。`,
    '项目主页：https://github.com/lesliechueng4-ctrl/cengjian',
  ]);
}

/**
 * Assembles the package folder and, unless `zip` is false, the zip next to it.
 * @param {{outDir?: string, zip?: boolean, nodeExe?: string, root?: string}} [opts]
 * @returns {{dir: string, zip: string|null}}
 */
export function buildPackage({ outDir = path.join(ROOT, 'dist'), zip = true, nodeExe = process.execPath, root = ROOT } = {}) {
  if (path.extname(nodeExe).toLowerCase() !== '.exe') {
    throw new Error('这个打包脚本要在 Windows 上运行（需要把 node.exe 一起打进去）。');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dir = path.join(outDir, PACKAGE_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node'), { recursive: true });

  for (const rel of APP_FILES) {
    fs.cpSync(path.join(root, rel), path.join(dir, 'app', rel), {
      recursive: true,
      // Leftovers from local testing never ship.
      filter: (src) => !path.basename(src).startsWith('.'),
    });
  }
  fs.copyFileSync(path.join(root, 'README.md'), path.join(dir, 'app', 'README.md'));

  fs.copyFileSync(nodeExe, path.join(dir, 'node', 'node.exe'));

  fs.writeFileSync(path.join(dir, 'start.bat'), startBat());
  fs.writeFileSync(path.join(dir, 'README.txt'), readmeTxt({ version: `v${pkg.version}`, nodeVersion: process.version }));

  let zipPath = null;
  if (zip) {
    zipPath = path.join(outDir, `${PACKAGE_DIR}-v${pkg.version}.zip`);
    fs.rmSync(zipPath, { force: true });
    const r = spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${dir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('压缩失败：没能生成 zip（文件夹已经生成，可以手动压缩）。');
  }
  return { dir, zip: zipPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = buildPackage({ zip: !process.argv.includes('--no-zip') });
    console.log('文件夹：', out.dir);
    if (out.zip) console.log('压缩包：', out.zip, `（${(fs.statSync(out.zip).size / 1048576).toFixed(1)} MB）`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
