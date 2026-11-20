// Sorties de commandes renvoyées au modèle : ce qu'il relit à CHAQUE requête suivante de la conversation.
// Principe : rien n'est perdu tant que la sortie tient dans la limite. Au-delà, on retire d'abord ce qui n'apporte rien
// (barres de progression réécrites, lignes répétées), puis on coupe le milieu en GARDANT les lignes d'erreur et
// d'avertissement — avant, la coupe début + fin perdait l'avertissement du milieu et le modèle relançait la commande.
// Aucun accès disque ni réseau : fonctions pures (utilisées par le moteur natif et par la passerelle).

/** Coupe simple au milieu (dernier recours, et pour tout ce qui n'est pas une sortie de commande). */
export function clipMiddle(text, max = 12000) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6), tail = max - head;
  return `${text.slice(0, head)}\n\n… [${text.length - max} caractères omis] …\n\n${text.slice(-tail)}`;
}

/** Retours chariot comme dans un terminal : sur une ligne « 10%\r20%\r100% », seul « 100% » reste affiché. Sans perte. */
export function resolveCarriageReturns(text) {
  const s = String(text ?? '');
  if (!s.includes('\r')) return s;
  return s.replace(/\r\n/g, '\n').split('\n').map(l => {
    if (!l.includes('\r')) return l;
    const parts = l.split('\r').filter(p => p.length);
    return parts.length ? parts[parts.length - 1] : '';
  }).join('\n');
}

/** Lignes d'erreur, d'avertissement ou d'échec (anglais et français), gardées quand on coupe le milieu. */
export const IMPORTANT_LINE = /\b(?:errors?|err!|warn(?:ing)?s?|fail(?:ed|ures?|s)?|fatal|panic|exceptions?|traceback|deprecat\w*|denied|cannot|unable|not found|undefined reference|segmentation fault|erreurs?|avertissements?|échecs?|échoué|introuvable|impossible)\b|[a-z]+(?:warning|error|exception)\b|✖|✗|⚠|\bnot ok\b/i;

const skeleton = l => l.replace(/\d+/g, '#').trim();

/**
 * Regroupe les lignes répétées : identiques (« ligne [× 12] ») puis presque identiques, qui ne diffèrent que par des
 * nombres (« compiling 1/180 » … « compiling 180/180 » → première, « [… 178 lignes semblables] », dernière).
 * Les lignes importantes ne sont jamais regroupées avec d'autres.
 */
export function collapseRepeats(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const n = j - i;
    if (n >= 3 && lines[i].trim()) { out.push(`${lines[i]}  [× ${n}]`); i = j; continue; }
    out.push(...lines.slice(i, j)); i = j;
  }
  // motifs qui se répètent (1 à 4 lignes, ex. « compiling 7/180 » ×3 puis « cache hit ») et ne diffèrent que par des nombres :
  // premier motif, « [… N lignes semblables] », dernier motif. Une ligne importante casse toujours le motif.
  const sks = out.map(l => (l.trim() && !IMPORTANT_LINE.test(l) ? skeleton(l) : null));
  const res = [];
  for (let i = 0; i < out.length;) {
    let best = null;
    for (let p = 1; p <= 4 && i + p <= out.length; p++) {
      const block = sks.slice(i, i + p);
      if (block.some(s => s == null) || !block.some(s => s.includes('#'))) continue;
      let r = 1;
      while (i + (r + 1) * p <= out.length && block.every((s, k) => sks[i + r * p + k] === s)) r++;
      if (r >= 3 && r * p >= 6 && (!best || r * p > best.r * best.p)) best = { p, r };
    }
    if (!best) { res.push(out[i]); i++; continue; }
    const { p, r } = best, end = i + r * p;
    res.push(...out.slice(i, i + p), `[… ${(r - 2) * p} lignes semblables]`, ...out.slice(end - p, end));
    i = end;
  }
  return res.join('\n');
}

const clipLine = (l, n = 400) => l.length > n ? l.slice(0, n) + ' […]' : l;

/**
 * Sortie de commande ramenée à max caractères au plus. Sous la limite : inchangée (hors retours chariot).
 * Au-delà : lignes répétées regroupées, puis début + lignes d'erreur/avertissement du milieu + fin.
 */
export function fitOutput(text, max = 12000) {
  const raw = resolveCarriageReturns(text);
  if (raw.length <= max) return raw;
  let s = collapseRepeats(raw);
  const note = `[Sortie réduite par FS-CLI : ${raw.length} → `;
  if (s.length + 120 <= max) return `${note}${s.length} caractères ; lignes répétées regroupées, rien d'autre de retiré]\n${s}`;

  const lines = s.split('\n');
  // lignes importantes : on les choisit d'abord (≤ 30 % de la place), début et fin se partagent le reste
  const impBudget = Math.floor(max * 0.3);
  const headTarget = () => Math.floor((max - 400 - impUsed) * 0.55);
  let impUsed = 0;
  const imp = [];
  // indices candidats : tout sauf les 15 premières et 15 dernières lignes (de toute façon dans début/fin)
  for (let i = 15; i < lines.length - 15; i++) {
    if (!IMPORTANT_LINE.test(lines[i])) continue;
    const l = clipLine(lines[i]);
    if (impUsed + l.length + 1 > impBudget) { imp.push({ i, l: null }); continue; }
    imp.push({ i, l }); impUsed += l.length + 1;
  }
  const hT = headTarget(), tT = max - 400 - impUsed - hT;
  let h = 0, hc = 0;
  while (h < lines.length && hc + lines[h].length + 1 <= hT) hc += lines[h++].length + 1;
  let t = lines.length, tc = 0;
  while (t > h && tc + lines[t - 1].length + 1 <= tT) tc += lines[--t].length + 1;
  if (h === 0 && t === lines.length) return clipMiddle(raw, max - 64);    // lignes géantes (fichier minifié…) : coupe par caractères
  const mid = imp.filter(x => x.i >= h && x.i < t);
  const kept = mid.filter(x => x.l), dropped = mid.length - kept.length;
  const omitted = (t - h) - kept.length;
  const parts = [lines.slice(0, h).join('\n')];
  parts.push(`[… ${omitted} lignes omises au milieu${kept.length ? ` ; ${kept.length} ligne${kept.length > 1 ? 's' : ''} d'erreur/avertissement gardée${kept.length > 1 ? 's' : ''} ci-dessous` : ' (aucune ligne d\'erreur ni d\'avertissement)'}${dropped ? ` ; ${dropped} autre${dropped > 1 ? 's' : ''} non gardée${dropped > 1 ? 's' : ''}` : ''} …]`);
  if (kept.length) parts.push(kept.map(x => x.l).join('\n'), '[…]');
  parts.push(lines.slice(t).join('\n'));
  let out = parts.join('\n');
  out = `${note}${out.length} caractères ; début, fin, et lignes d'erreur/avertissement gardés]\n${out}`;
  return out.length > max ? clipMiddle(out, max - 64) : out;
}

export const TEST_CMD = /node\s+--test|\bjest\b|\bvitest\b|\bpytest\b|npm\s+(?:run\s+)?test\b|\bmocha\b|\bgo\s+test\b|\bcargo\s+test\b|\bphpunit\b|\bdotnet\s+test\b/;

/**
 * Sortie de tests trop longue (plus de 4 000 caractères) : blocs d'échec (not ok, ✖, FAIL, AssertionError + 15 lignes),
 * lignes d'avertissement, et bilan final (20 dernières lignes). Courte ou autre commande : inchangée.
 */
export function condenseTestOutput(command, output) {
  const out = String(output ?? '');
  if (out.length <= 4000 || !TEST_CMD.test(String(command || ''))) return out;
  const lines = out.split('\n');
  const keep = new Uint8Array(lines.length);
  const FAIL = /\bnot ok\b|✖|\bFAIL(?:ED)?\b|AssertionError|\bpanicked\b/;
  const WARN = /warn(?:ing)?s?\b|deprecat|⚠/i;
  lines.forEach((l, i) => {
    if (FAIL.test(l)) for (let j = i; j <= Math.min(lines.length - 1, i + 15); j++) keep[j] = 1;
    else if (WARN.test(l)) keep[i] = 1;
  });
  for (let j = Math.max(0, lines.length - 20); j < lines.length; j++) keep[j] = 1;
  const kept = [];
  let gap = false;
  lines.forEach((l, i) => {
    if (keep[i]) { if (gap) kept.push('…'); kept.push(l); gap = false; } else gap = true;
  });
  const n = keep.reduce((s, k) => s + k, 0);
  return `[Sortie de test condensée : ${n} lignes sur ${lines.length} (échecs, avertissements et bilan)]\n${kept.join('\n')}`;
}

/** Sortie d'une commande pour le modèle : tests condensés, puis réduite à max si besoin. */
export function commandOutput(command, text, max = 12000) {
  return fitOutput(condenseTestOutput(command, resolveCarriageReturns(text)), max);
}

/** Parts équitables (« water-filling ») : chacun reçoit au moins max(1500, total/n), ce que les petits n'utilisent pas est redistribué. */
export function shares(lengths, total) {
  const n = lengths.length;
  const out = new Array(n).fill(0);
  let left = total, rest = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  while (rest.length) {
    const fair = Math.floor(left / rest.length);
    const small = rest.filter(x => x.len <= fair);
    if (!small.length) { for (const x of rest) out[x.i] = Math.max(1500, fair); break; }
    for (const x of small) { out[x.i] = x.len; left -= x.len; }
    rest = rest.filter(x => x.len > fair);
  }
  return out;
}
