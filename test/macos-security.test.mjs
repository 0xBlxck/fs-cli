// Politique de sécurité : commandes et dossiers propres au Mac (audit macOS du 17/11/2026) — tests hors ligne, aucune commande lancée
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FS_CLI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-macsec-'));
const { judgeCommand, sensitivePathReason } = await import('../src/permissions.js');
const action = cmd => judgeCommand(cmd, { cwd: '/Users/marie/projet' }).level;   // scan-ignore (faux chemin de test)

test('Mac : effacer un disque est refusé', () => {
  for (const c of ['diskutil eraseDisk APFS Vide /dev/disk2', 'diskutil zeroDisk disk3', 'diskutil apfs deleteContainer disk1', 'diskutil partitionDisk disk2 GPT JHFS+ X 100%']) assert.equal(action(c), 'deny', c);
});

test('Mac : commandes système sensibles → confirmation', () => {
  for (const c of [
    'osascript -e \'tell application "Finder" to delete every item of desktop\'',
    'launchctl load ~/Library/LaunchAgents/x.plist', 'defaults write com.apple.dock autohide -bool true',
    'security find-generic-password -s github -w', 'security dump-keychain', 'csrutil disable', 'spctl --master-disable',
    'tmutil deletelocalsnapshots /', 'diskutil unmountDisk disk2', 'xattr -d com.apple.quarantine app.dmg', 'nvram boot-args="-v"',
  ]) assert.equal(action(c), 'ask', c);
});

test('Mac : commandes en lecture seule → libres', () => {
  for (const c of ['diskutil list', 'defaults read com.apple.dock', 'launchctl list', 'csrutil status', 'pmset -g', 'xattr -l fichier.txt', 'security list-keychains']) assert.equal(action(c), 'safe', c);
});

test('Mac : trousseau, cookies et profils de navigateur protégés ; dossier temporaire du Mac libre', () => {
  assert.ok(sensitivePathReason('/Users/marie/Library/Keychains/login.keychain-db'));   // scan-ignore (faux chemin de test)
  assert.ok(sensitivePathReason('/Users/marie/Library/Application Support/Google/Chrome/Default/Cookies'));   // scan-ignore (faux chemin de test)
  assert.ok(sensitivePathReason('/Users/marie/Library/Application Support/Google/Chrome/Default/Login Data'));   // scan-ignore (faux chemin de test)
  assert.equal(sensitivePathReason('/Users/marie/projet/cookies.js'), null);   // scan-ignore (faux chemin de test)
  assert.equal(sensitivePathReason('/private/var/folders/ab/T/fs-cli-images/x.png'), null);
});
