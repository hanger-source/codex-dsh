import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readDshLaunch } from '../skills/codex-dsh/scripts/environment.mjs';
import { queueCodexMessage, inspectCodex, bindingFilePath, readBinding } from '../skills/codex-dsh/scripts/sdk.mjs';

const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh 中文 '));

test('PowerShell UTF-16, UTF-8 BOM and CRLF files are accepted without exposing their token in errors', async () => {
  const url = 'http://127.0.0.1:3080/?token=LOCAL_SECRET';
  for (const [label, bytes] of [
    ['ps5', Buffer.concat([Buffer.from([255, 254]), Buffer.from(url + '\r\n', 'utf16le')])],
    ['utf8-bom', Buffer.from('\uFEFF' + url + '\r\n')],
    ['ps7', Buffer.from(url + '\n')],
  ]) {
    const file = path.join(root, label + '.url');
    await fs.writeFile(file, bytes);
    assert.equal((await readDshLaunch({ urlFile: file })).launch.href, url);
  }
  const invalid = path.join(root, 'invalid.url');
  for (const value of ['bad LOCAL_SECRET', 'https://remote.invalid/?token=LOCAL_SECRET', 'file:///C:/LOCAL_SECRET']) {
    await fs.writeFile(invalid, value);
    await assert.rejects(readDshLaunch({ urlFile: invalid }), error => !error.message.includes('LOCAL_SECRET'));
  }
});

test('explicit connection errors and mismatched endpoints cannot silently select another install', async () => {
  const file = path.join(root, 'current.url');
  await fs.writeFile(file, 'http://127.0.0.1:3080/?token=LOCAL_SECRET');
  await assert.rejects(readDshLaunch({ urlFile: file, expectedEndpoint: 'http://127.0.0.1:3081/' }), /endpoint/);
  await assert.rejects(readDshLaunch({ urlFile: path.join(root, 'missing.url') }), /ENOENT/);
  await assert.rejects(inspectCodex({ codex: path.join(root, 'missing-codex.exe') }), /queue/);
});

test('CLI and bindings work under paths containing spaces and non-ASCII characters', async () => {
  const scripts = path.join(root, '脚本');
  await fs.cp(fileURLToPath(new URL('../skills/codex-dsh/scripts/', import.meta.url)), scripts, { recursive: true });
  const { stdout } = await exec(process.execPath, [path.join(scripts, 'dsh.mjs'), 'help'], { windowsHide: true });
  assert.ok(JSON.parse(stdout).commands.doctor);
  const options = { stateDir: root, thread: '12345678-1234-1234-1234-123456789012' };
  await fs.writeFile(bindingFilePath(options), JSON.stringify({ workspace: root }));
  assert.deepEqual(await readBinding(options), { workspace: root });
});

test('queue uses an argument array: Chinese, multiline text, quotes and shell syntax arrive unchanged', async () => {
  // The executable is Node itself. Its inert "queue" program records argv, never contacts Codex.
  await fs.writeFile(path.join(root, 'queue'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  const text = '中文消息\n"quoted" & $(whoami) `echo bad` %PATH% | > <';
  const thread = '12345678-1234-1234-1234-123456789012';
  const result = await queueCodexMessage({ executable: process.execPath, thread, text, workspace: root });
  assert.deepEqual(JSON.parse(result.receipt), ['--thread', thread, '--message', text]);
});

test('CLI report decodes a PowerShell 5 message file before passing it to the bound executable', async () => {
  const directory = await fs.mkdtemp(path.join(root, '汇报 '));
  const thread = '12345678-1234-1234-1234-123456789012';
  await fs.writeFile(path.join(directory, 'queue'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  await fs.writeFile(bindingFilePath({ thread, stateDir: directory }), JSON.stringify({
    sessionId: 'test-only', codexThreadId: thread, codexExecutable: process.execPath, workspace: directory,
  }));
  const text = '中文汇报\r\n不是乱码 & "quoted"';
  const file = path.join(directory, 'message.txt');
  await fs.writeFile(file, Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]));
  const cli = fileURLToPath(new URL('../skills/codex-dsh/scripts/dsh.mjs', import.meta.url));
  const { stdout } = await exec(process.execPath, [cli, 'report', '--thread', thread, '--session', 'test-only', '--file', file], {
    env: { ...process.env, CODEX_DSH_STATE_DIR: directory }, windowsHide: true,
  });
  const receipt = JSON.parse(stdout);
  const argv = JSON.parse(receipt.receipt);
  assert.deepEqual(argv.slice(0, 3), ['--thread', thread, '--message']);
  assert.ok(argv[3].endsWith(text));
});
