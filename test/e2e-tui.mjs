// Test de bout en bout : lance le vrai cli.js dans un terminal simulé, tape au clavier, lit l'écran.
// Usage : node test/e2e-tui.mjs <dossier-de-travail> "<demande>" [--plan]
// (utilise la vraie API FS ; FS_CLI_HOME doit pointer vers un dossier temporaire)
import { EventEmitter } from 'node:events';
import { TermSim } from './term-sim.js';

const [dir, request, flag] = process.argv.slice(2);
const sim = new TermSim(100, 45);
const stdin = new EventEmitter();
Object.assign(stdin, { isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
Object.defineProperty(process.stdout, 'rows', { value: 45, configurable: true });
process.stdout.write = s => { sim.write(String(s)); return true; };
let exited = null;
process.exit = code => { exited = code ?? 0; };
process.argv = ['node', 'cli.js', '--cwd', dir, '-m', 'sonnet'];

const type = s => stdin.emit('data', Buffer.from(s, 'utf8'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (re, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(sim.all())) return true; await wait(150); } return false; };
const snap = (title) => { console.error(`\n===== ${title} =====\n${sim.screen()}\n`); };

await import('../cli.js');
await wait(500);
snap('1. démarrage');

type('/mo'); await wait(200);
snap('2. suggestions après « /mo »');
type('\x15');                                   // ctrl+u : vide la saisie

if (flag === '--plan') { type('\x1b[Z'); await wait(300); snap('3. après Maj+Tab (mode)'); type('\x1b[Z'); type('\x1b[Z'); await wait(200); }

type(request); await wait(200);
snap('3. demande tapée');
type('\r');
await wait(1500);
snap('4. pendant le travail (spinner + saisie active)');
type('une 2e question en file'); type('\r'); await wait(300);
snap('5. message mis en file pendant le travail');
const ok = await until(/─ \d+(\.\d+)?s/);
await wait(800);
snap(ok ? '6. fin du premier tour' : '6. TIMEOUT');
const ok2 = await until(/─ \d+(\.\d+)?s[\s\S]*─ \d+(\.\d+)?s/, 120000);   // la 2e demande (file d'attente) s'exécute à la suite
await wait(500);
snap(ok2 ? '7. après la demande en file' : '7. TIMEOUT 2e');
type('\x03'); type('\x03'); await wait(300);
console.error(`sortie demandée: ${exited}`);
process.stdout.write = () => true;
