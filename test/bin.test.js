import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('package.json exposes the CLI as the blockchain-checker bin', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.bin['blockchain-checker'], 'src/cli.js');
  assert.match(readFileSync(cli, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.ok(statSync(cli).mode & 0o111, 'src/cli.js must be executable');
});

test('the CLI runs when invoked through a symlink, as an installed bin is', async () => {
  // Regression: comparing import.meta.url with process.argv[1] failed for a
  // symlink, so the installed command printed nothing and exited 0.
  const dir = mkdtempSync(join(tmpdir(), 'blockchain-checker-'));
  try {
    const link = join(dir, 'blockchain-checker');
    symlinkSync(cli, link);
    const { stdout } = await run(process.execPath, [link, '--help']);
    assert.match(stdout, /^Usage: blockchain-checker <command>/);

    await assert.rejects(run(process.execPath, [link, 'nope']), (err) => {
      assert.equal(err.code, 3);
      assert.match(err.stderr, /Unknown command 'nope'/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importing the CLI module does not run it', async () => {
  const { stdout } = await run(process.execPath, [
    '--input-type=module', '-e', `await import(${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)}); console.log('imported');`,
  ]);
  assert.equal(stdout, 'imported\n');
});
