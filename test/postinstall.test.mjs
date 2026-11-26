// « fs-cli » tapé dans PowerShell, cmd ou bash : sous Windows, un PowerShell neuf bloque les scripts (fs-cli.ps1 refusé).
// L'installation met alors ce lanceur de côté (PowerShell prend fs-cli.cmd), sans jamais toucher à la sécurité de Windows.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const { fixPowerShellShims, globalPrefix, BLOCKING } = await import('../src/postinstall.js');
const { installCmd } = await import('../src/update.js');

/** dossier global de npm simulé : <prefix>/fs-cli{,.cmd,.ps1}, fs-mcp…, et le paquet dans <prefix>/node_modules/fs-cli */
function fakePrefix({ cmd = true } = {}) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-npm-'));
  const pkgRoot = path.join(prefix, 'node_modules', 'fs-cli');
  fs.mkdirSync(pkgRoot, { recursive: true });
  for (const n of ['fs-cli', 'fs-mcp']) {
    fs.writeFileSync(path.join(prefix, n), '#!/bin/sh');
    fs.writeFileSync(path.join(prefix, n + '.ps1'), '# ps1');
    if (cmd) fs.writeFileSync(path.join(prefix, n + '.cmd'), '@echo off');
  }
  if (!cmd) fs.writeFileSync(path.join(prefix, 'fs-cli.cmd'), '@echo off');   // le dossier reste reconnu comme global
  return { prefix, pkgRoot };
}
const ls = p => fs.readdirSync(p).filter(f => f.startsWith('fs-')).sort();

test('Windows, PowerShell qui bloque les scripts : fs-cli.ps1 et fs-mcp.ps1 mis de côté (renommés), .cmd et lanceur bash gardés', () => {
  const { prefix, pkgRoot } = fakePrefix();
  const r = fixPowerShellShims({ pkgRoot, env: { FS_CLI_TEST_POLICY: 'Restricted' }, platform: 'win32' });
  assert.deepEqual(r.moved, ['fs-cli.ps1', 'fs-mcp.ps1']);
  assert.deepEqual(ls(prefix), ['fs-cli', 'fs-cli.cmd', 'fs-cli.ps1.bloque', 'fs-mcp', 'fs-mcp.cmd', 'fs-mcp.ps1.bloque']);
  // mise à jour : npm recrée fs-cli.ps1 → de nouveau mis de côté, sans erreur
  fs.writeFileSync(path.join(prefix, 'fs-cli.ps1'), '# ps1 v2');
  const r2 = fixPowerShellShims({ pkgRoot, env: { FS_CLI_TEST_POLICY: 'Undefined' }, platform: 'win32' });
  assert.deepEqual(r2.moved, ['fs-cli.ps1']);
  assert.equal(fs.readFileSync(path.join(prefix, 'fs-cli.ps1.bloque'), 'utf8'), '# ps1 v2');
});

test('PowerShell qui autorise les scripts, autre système, installation locale ou .cmd absent : rien ne bouge', () => {
  for (const pol of ['RemoteSigned', 'Unrestricted', 'Bypass']) {
    const { prefix, pkgRoot } = fakePrefix();
    const r = fixPowerShellShims({ pkgRoot, env: { FS_CLI_TEST_POLICY: pol }, platform: 'win32' });
    assert.deepEqual(r.moved, [], pol);
    assert.ok(fs.existsSync(path.join(prefix, 'fs-cli.ps1')), pol);
  }
  let { prefix, pkgRoot } = fakePrefix();
  assert.deepEqual(fixPowerShellShims({ pkgRoot, env: { FS_CLI_TEST_POLICY: 'Restricted' }, platform: 'darwin' }).moved, []);
  assert.equal(fixPowerShellShims({ pkgRoot: os.tmpdir(), env: { FS_CLI_TEST_POLICY: 'Restricted' }, platform: 'win32' }).prefix, null, 'pas une installation globale (dossier de développement)');
  ({ prefix, pkgRoot } = fakePrefix({ cmd: false }));
  const r = fixPowerShellShims({ pkgRoot, env: { FS_CLI_TEST_POLICY: 'Restricted' }, platform: 'win32' });
  assert.deepEqual(r.moved, ['fs-cli.ps1'], 'fs-mcp.ps1 gardé : pas de fs-mcp.cmd de secours');
  assert.ok(fs.existsSync(path.join(prefix, 'fs-mcp.ps1')));
  assert.equal(globalPrefix(pkgRoot, { npm_config_prefix: prefix }), prefix);
  assert.ok(BLOCKING.test('AllSigned') && !BLOCKING.test('RemoteSigned'));
});

test('installation : script lancé par npm après l\'installation ; commande affichée avec npm.cmd sous Windows (npm.ps1 bloqué aussi)', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.postinstall, 'node src/postinstall.js');
  assert.ok(pkg.files.includes('src/'), 'src/postinstall.js livré dans le paquet');
  assert.match(installCmd('win32'), /^npm\.cmd install -g https:\/\/github\.com\/0xBlxck\/fs-cli\/archive\/refs\/heads\/main\.tar\.gz$/);
  assert.match(installCmd('darwin'), /^npm install -g /);
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /npm\.cmd install -g https:\/\/github\.com\/0xBlxck\/fs-cli/);
  assert.doesNotMatch(readme, /Set-ExecutionPolicy/, 'plus besoin de changer la sécurité de Windows');
});
