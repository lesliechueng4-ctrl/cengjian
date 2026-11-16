import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPackage, startBat, readmeTxt, PACKAGE_DIR, APP_FILES } from '../scripts/build-win.mjs';

test('start.bat: Windows line endings, runs the bundled Node from the app folder, never a system Node', () => {
  const bat = startBat();
  const lines = bat.split('\r\n');
  assert.ok(!bat.replace(/\r\n/g, '').includes('\n'), 'no bare LF (cmd misreads UTF-8 lines without CRLF)');
  assert.equal(lines[0], '@echo off');
  assert.ok(lines.includes('cd /d "%~dp0app"'));
  assert.ok(lines.includes('"%~dp0node\\node.exe" server.js'));
  assert.ok(!lines.some((l) => /^node\s/.test(l.trim())), 'does not rely on Node being installed');
  assert.ok(!/[A-Z]:\\/.test(bat), 'no machine-specific paths');
});

test('README.txt starts with a BOM and names the version and the bundled Node', () => {
  const txt = readmeTxt({ version: 'v9.9.9', nodeVersion: 'v20.1.0' });
  assert.equal(txt.charCodeAt(0), 0xfeff);
  assert.ok(txt.includes('v9.9.9') && txt.includes('v20.1.0'));
  assert.ok(txt.includes('start.bat'));
});

test('buildPackage: app files, bundled node.exe, launcher and readme; test leftovers are left out', async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chaipai-build-'));
  try {
    // A stand-in repository and a stand-in node.exe, so the test does not copy the real 90 MB runtime.
    const root = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(root, 'public', 'js'), { recursive: true });
    fs.mkdirSync(path.join(root, 'public', '.scratch'), { recursive: true });
    for (const f of [...APP_FILES.filter((x) => x !== 'public' && x !== 'package.json'), 'README.md']) fs.writeFileSync(path.join(root, f), f);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'chaipai', version: '1.2.3' }));
    fs.writeFileSync(path.join(root, 'public', 'index.html'), '<title>x</title>');
    fs.writeFileSync(path.join(root, 'public', 'js', 'app.js'), '//');
    fs.writeFileSync(path.join(root, 'public', '.scratch', 't.mp4'), 'leftover');
    const nodeExe = path.join(tmp, 'node.exe');
    fs.writeFileSync(nodeExe, 'MZ');

    const out = buildPackage({ outDir: path.join(tmp, 'dist'), zip: false, nodeExe, root });
    assert.equal(out.zip, null);
    assert.equal(out.dir, path.join(tmp, 'dist', PACKAGE_DIR));
    assert.deepEqual(fs.readdirSync(out.dir).sort(), ['README.txt', 'app', 'node', 'start.bat']);
    assert.deepEqual(fs.readdirSync(path.join(out.dir, 'app')).sort(), [...APP_FILES, 'README.md'].sort());
    assert.deepEqual(fs.readdirSync(path.join(out.dir, 'app', 'public')).sort(), ['index.html', 'js']);
    assert.equal(fs.readFileSync(path.join(out.dir, 'node', 'node.exe'), 'utf8'), 'MZ');
    assert.equal(fs.readFileSync(path.join(out.dir, 'start.bat'), 'utf8'), startBat());
    assert.ok(fs.readFileSync(path.join(out.dir, 'README.txt'), 'utf8').includes('v1.2.3'));

    // Building again replaces the folder instead of mixing old and new files.
    fs.writeFileSync(path.join(out.dir, 'app', 'stale.txt'), 'old');
    buildPackage({ outDir: path.join(tmp, 'dist'), zip: false, nodeExe, root });
    assert.ok(!fs.existsSync(path.join(out.dir, 'app', 'stale.txt')));

    assert.throws(() => buildPackage({ outDir: path.join(tmp, 'dist'), zip: false, nodeExe: '/usr/bin/node', root }), /Windows/);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test('everything the package copies exists in the repository', () => {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  for (const rel of [...APP_FILES, 'README.md']) assert.ok(fs.existsSync(path.join(root, rel)), rel);
});
