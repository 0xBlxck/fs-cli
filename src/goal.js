// /goal : un objectif à atteindre, comme dans Claude Code : le modèle continue tout seul jusqu'à ce que la condition soit
// remplie. Différence assumée : Claude Code fait juger chaque réponse par un vérificateur séparé ; le modèle de France
// Student refuse ce rôle (vu en vrai le 28/11/2026 : « le chat de France Student ne peut pas servir de moteur à un outil
// ou à un agent externe »), et on ne contourne pas ses règles. Ici, c'est le modèle qui travaille qui VÉRIFIE AVEC SES
// OUTILS (relire le fichier, relancer les tests) puis termine sa réponse par une ligne d'état que FS-CLI lit :
//   🎯 atteint : <preuve>   ·   🎯 pas encore : <ce qui manque>   ·   🎯 impossible : <pourquoi>
// Aucune conversation en plus (limite de 50 par jour), tout se passe dans la conversation de travail.

/** nombre de reprises automatiques avant de se mettre en pause (chaque reprise coûte des messages sur le budget du chat) */
export const GOAL_MAX_TURNS = 20;

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** consigne de la ligne d'état, jointe à chaque message de /goal */
export const STATUS_RULE = 'Avant de finir, vérifie avec tes outils que c\'est vraiment fait (relis le fichier, relance les tests ou la commande) : '
  + 'ne te fie pas à ce que tu crois avoir fait. Termine ta réponse par UNE de ces lignes, seule sur sa ligne : '
  + '« 🎯 atteint : <la preuve que tu viens de vérifier> », « 🎯 pas encore : <ce qui manque> » ou « 🎯 impossible : <pourquoi, après avoir essayé> ».';

/** message qui lance le travail quand l'objectif est fixé */
export const startMessage = condition => `[Objectif fixé avec /goal : « ${condition} ». Travaille tout de suite pour y arriver, sans demander quoi faire : la condition elle-même est ta consigne. ${STATUS_RULE}]`;

/** message de reprise : l'objectif n'est pas encore atteint */
export const continueMessage = (condition, reason, n) => `[Objectif /goal pas encore atteint (étape ${n}${reason ? ` : « ${reason} »` : ''}). Continue à travailler pour que cette condition soit remplie : « ${condition} ». Ne demande pas quoi faire ; si tu es vraiment bloqué, dis pourquoi. ${STATUS_RULE}]`;

/**
 * Ligne d'état en fin de réponse → { state: 'met' | 'not' | 'impossible', reason } ; null s'il n'y en a pas.
 * La dernière ligne d'état compte (le modèle peut en citer une plus haut en expliquant).
 */
export function parseStatus(text) {
  const lines = String(text ?? '').split('\n').map(l => l.replace(/^[\s>*_`#-]+|[\s*_`]+$/g, '')).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const m = /^🎯\s*(?:objectif\s+)?(atteint|pas\s+encore(?:\s+atteint)?|impossible)\b\s*[:：—-]?\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    const k = m[1].toLowerCase();
    return { state: k.startsWith('atteint') ? 'met' : k.startsWith('impossible') ? 'impossible' : 'not', reason: cut(m[2], 400) };
  }
  return null;
}

/** texte du dernier message de l'assistant dans une requête de Claude Code (format Anthropic) */
export function lastAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.role !== 'assistant') continue;
    const t = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '');
    if (t.trim()) return t;
  }
  return '';
}

/**
 * Réponse au vérificateur de Claude Code (fs claude), d'après la ligne d'état de la dernière réponse du modèle.
 * → { ok, reason, impossible? } : jamais un « atteint » sans la ligne « 🎯 atteint ».
 */
export function hookVerdict(messages) {
  const st = parseStatus(lastAssistantText(messages));
  if (st?.state === 'met') return { ok: true, reason: st.reason || 'condition vérifiée par le modèle' };
  if (st?.state === 'impossible') return { ok: false, impossible: true, reason: st.reason || 'impossible selon le modèle' };
  const why = st?.reason ? `pas encore : ${st.reason}` : 'pas encore confirmé';
  return { ok: false, reason: `${why}. ${STATUS_RULE}` };
}

/** message de Claude Code quand /goal est activé (en anglais) → consigne en français, avec la ligne d'état attendue */
export function goalStartFromClaudeCode(text) {
  const m = /A session-scoped Stop hook is now active with condition: "([\s\S]*?)"\. Briefly acknowledge the goal/.exec(String(text ?? ''));
  return m ? startMessage(m[1]) : null;
}
