// Liste de tâches du modèle (« - [ ] étape », « - [x] faite », « - [~] en cours ») : il l'écrit une fois, puis seulement
// les lignes qui changent. FS-CLI garde la liste et affiche à chaque fois la liste COMPLÈTE à jour : même suivi pour
// l'utilisateur, sans que le modèle recopie toute la liste à chaque étape (tokens de sortie, relus ensuite à chaque requête).
// Si le modèle réécrit quand même toute la liste, l'affichage est le même. Une liste sans rapport avec la précédente la remplace.

const ITEM = /^(\s*)[-*] \[([ xX~])\] (.*)$/;
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[*_`~]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function same(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 8 && l.startsWith(s);                          // « Lancer les tests » ↔ « Lancer les tests (npm test) »
}

/** Fusionne un bloc de lignes de liste avec la liste en cours (state.todos). Renvoie les lignes à afficher. */
export function mergeTodos(state, lines) {
  const items = lines.map(l => { const m = ITEM.exec(l); return { mark: m[2].toLowerCase(), text: m[3].trim() }; });
  const prev = state.todos || [];
  const fresh = items.length >= 2 && items.every(i => i.mark === ' ');
  const hits = fresh ? [] : items.map(i => prev.findIndex(p => same(p.text, i.text)));
  if (fresh || !prev.length || hits.every(h => h < 0)) {             // nouvelle liste (ou sans rapport) : affichée telle quelle
    state.todos = items;
    return lines;
  }
  const next = prev.map(p => ({ ...p }));
  items.forEach((it, k) => {
    if (hits[k] >= 0) next[hits[k]].mark = it.mark;
    else next.push(it);                                               // étape ajoutée en cours de route
  });
  state.todos = next;
  return next.map(i => `- [${i.mark}] ${i.text}`);
}

/**
 * Filtre du texte affiché, morceau par morceau : les lignes de liste consécutives sont retenues jusqu'à la fin du bloc,
 * puis remplacées par la liste complète à jour. Le reste passe tout de suite (affichage en direct inchangé).
 */
export function todoView(state) {
  let line = '', block = [], passing = false;
  const startsItem = s => ITEM.test(s) || /^\s*(?:[-*](?: (?:\[(?:[ xX~](?:\]\s?)?)?)?)?)?$/.test(s);   // début possible d'une ligne de liste
  const flushBlock = () => { if (!block.length) return ''; const out = mergeTodos(state, block).join('\n') + '\n'; block = []; return out; };
  const push = d => {
    let out = '';
    for (const ch of String(d || '')) {
      if (passing) { out += ch; if (ch === '\n') passing = false; continue; }
      if (ch === '\n') {
        if (ITEM.test(line)) block.push(line);
        else out += flushBlock() + line + '\n';
        line = '';
        continue;
      }
      line += ch;
      if (!startsItem(line)) { out += flushBlock() + line; line = ''; passing = true; }
    }
    return out;
  };
  const flush = () => {
    let out = '';
    if (line && ITEM.test(line)) { block.push(line); line = ''; }
    out += flushBlock() + line;
    line = ''; passing = false;
    return out;
  };
  return { push, flush };
}
