// Compréhension des demandes en langage naturel : l'utilisateur parle normalement,
// le CLI déclenche la bonne fonction (équipe d'agents, comparaison de modèles, mémoire, quota…)
// sans qu'il ait à connaître les commandes. Fonction pure : aucune action ici, seulement une décision.

const NUM = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8 };
const NUM_RE = '(\\d+|un|une|deux|trois|quatre|cinq|six|sept|huit)';
const AGENT_RE = '(?:sous[- ]?agents?|subagents?|agents?|ia|bots?|workers?)';

// « plusieurs agents », « 3 agents », « des sous-agents », « en équipe », « multi-agents »
const TEAM_PATTERNS = [
  new RegExp(`\\b(plusieurs|des|quelques|\\d+|deux|trois|quatre|cinq|six|sept|huit)\\s+${AGENT_RE}\\b`, 'i'),   // pas « un agent » : ça désigne souvent ce qu'on veut coder
  /\bmulti[- ]?agents?\b/i,
  /\b(en|une|avec (une|ton|ta)?)\s*équipe\b/i,
  /\bsous[- ]?agents?\b/i,
];
const NO_TEAM = /\b(sans|pas d['e]|aucun)\s*(sous[- ]?)?agents?\b|\bseul\b/i;
const PARALLEL = /\ben\s+parall[eè]le\b|\ben\s+même\s+temps\b|\bsimultan[ée]ment\b|\ble\s+plus\s+vite\b|\brapidement\b/i;
const SEQUENTIAL = /\b(à|a)\s+la\s+suite\b|\bl['’]un\s+après\s+l['’]autre\b|\bdans\s+(la\s+)?même\s+conv/i;
const REVIEW = /\b(relis|relire|relecture|review|fais\s+(une\s+)?revue|contr[ôo]le\s+qualit[ée])\b/i;

// connecteurs à retirer autour de la consigne « agents » pour garder une tâche propre
const CLAUSE = new RegExp(
  `[,;]?\\s*(?:et\\s+)?(?:en\\s+)?(?:utilis\\w*|prends?|lance[rz]?|avec|fais[- ]le\\s+avec|mets?|emploie[rz]?|grâce\\s+à|via|par)?\\s*` +
  `(?:plusieurs|des|quelques|${NUM_RE.slice(1, -1)})?\\s*(?:${AGENT_RE}|multi[- ]?agents?|une\\s+équipe(?:\\s+d['e]\\s*${AGENT_RE})?|en\\s+équipe)` +
  `(?:\\s+(?:en\\s+parall[eè]le|en\\s+même\\s+temps|simultanément|à\\s+la\\s+suite))?`, 'gi');

function agentCount(text) {
  const m = text.match(new RegExp(`\\b${NUM_RE}\\s+${AGENT_RE}\\b`, 'i'));
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUM[m[1].toLowerCase()];
  return n >= 2 && n <= 8 ? n : null;
}

const MODELS = /\b(gpt[- ]?\S*|claude\S*|gemini\S*|mistral\S*|deepseek\S*|grok\S*|llama\S*|qwen\S*)\b/gi;

/**
 * Décide si la phrase de l'utilisateur doit déclencher une fonction du CLI.
 * @returns {null | { cmd: string, arg: string, label: string, then?: string, duelModel?: string }}
 */
export function detectIntent(raw) {
  const text = String(raw || '').trim();
  if (!text || text.startsWith('/') || text.startsWith('!')) return null;
  const head = text.slice(0, 600);                      // l'intention est dans la demande, pas dans un long collage
  const isQuestion = /\?\s*$/.test(head.split('\n')[0]);

  // ── mémoire : « retiens que… », « souviens-toi que… », « n'oublie pas que… »
  const mem = head.match(/^(?:s['’]il te pla[iî]t,?\s*)?(?:retiens|m[ée]morise|souviens[- ]toi|rappelle[- ]toi|n['’]oublie\s+pas|note\s+bien)\s*(?:bien\s*)?(?:que|qu['’]|:|de|d['’])?\s*([\s\S]+)/i);
  if (mem && mem[1].trim().length >= 3 && !text.includes('\n')) {
    return { cmd: '/remember', arg: mem[1].trim().replace(/[.!]+$/, ''), label: 'je retiens cette information (mémoire du dossier)' };
  }

  // ── quota / conversations restantes
  if (/\b(combien|reste[- ]?t[- ]?il|il\s+me\s+reste|mon\s+quota|ma\s+limite|mon\s+budget|ma\s+consommation)\b/i.test(head)
      && /\b(conv\w*|chats?|messages?|requ[êe]tes?|quota|limite|budget|cr[ée]dits?|consomm\w*)\b/i.test(head) && head.length < 160) {
    return /\bconv\w*|chats?\b/i.test(head)
      ? { cmd: '/chats', arg: '', label: 'tes conversations du jour' }
      : { cmd: '/quota', arg: '', label: 'ton quota' };
  }
  // ── contexte
  if (/\b(contexte|m[ée]moire\s+de\s+la\s+conv\w*)\b/i.test(head) && /\b(plein|rempli|o[ùu]\s+en\s+est|combien|taille|niveau|reste)\b/i.test(head) && head.length < 160) {
    return { cmd: '/context', arg: '', label: 'état du contexte' };
  }
  // ── nouvelle conversation / compactage
  if (head.length < 80 && /^(?:on\s+)?(?:ouvre\s+une\s+|commence\s+une\s+|d[ée]marre\s+une\s+)?nouvelle\s+(conv\w*|discussion|session)\s*[.!]?$|^(?:on\s+)?repar[st]\s+(?:de|à)\s+z[ée]ro\s*[.!]?$/i.test(head)) {
    return { cmd: '/new', arg: '', label: 'nouvelle conversation' };
  }
  if (head.length < 120 && /\b(compacte|r[ée]sume)\b.*\b(conv\w*|discussion|session|contexte)\b/i.test(head) && !isQuestion) {
    return { cmd: '/compact', arg: '', label: 'résumé de la conversation puis suite dans une nouvelle' };
  }

  // ── comparaison de modèles : « compare gpt et claude sur… », « demande à deux modèles… »
  const models = [...head.matchAll(MODELS)].map(m => m[1]);
  if (/\b(compare[rz]?|comparaison|deux\s+mod[eè]les|2\s+mod[eè]les|plusieurs\s+mod[eè]les|avis\s+de\s+deux)\b/i.test(head)
      && (models.length >= 1 || /mod[eè]les/i.test(head))) {
    const question = text
      .replace(/^(?:compare[rz]?|fais\s+une\s+comparaison)\s+(?:les\s+r[ée]ponses\s+)?(?:de\s+|d['’]\s*|entre\s+)?/i, '')
      .replace(MODELS, '').replace(/^\s*(?:et|vs\.?|contre|,)?\s*(?:et|vs\.?|contre|,)?\s*/i, '')
      .replace(/^(?:sur|pour|à\s+propos\s+de|:)\s*/i, '')
      .replace(/\b(?:demande|pose)\s+(?:la\s+question\s+)?à\s+(?:deux|2|plusieurs)\s+mod[eè]les\s*:?\s*/i, '').trim();
    if (question.length >= 3) return { cmd: '/compare', arg: question, label: `comparaison de deux modèles${models[1] || models[0] ? ' (' + models.join(' / ') + ')' : ''}`, duelModel: models[models.length - 1] || null };
  }

  // ── équipe d'agents : « fais ce site avec plusieurs agents », « utilise 3 agents en parallèle »
  if (!NO_TEAM.test(head) && !isQuestion && TEAM_PATTERNS.some(r => r.test(head))) {
    const task = text.replace(CLAUSE, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([,.;!])/g, '$1').replace(/^[\s,;.]+|[\s,;]+$/g, '').trim();
    if (task.length >= 6) {
      const n = agentCount(head);
      const mode = PARALLEL.test(head) ? 'pool' : SEQUENTIAL.test(head) ? 'same' : null;
      const review = REVIEW.test(head);
      const arg = [n ? `-n ${n}` : '', mode === 'pool' ? '--pool' : mode === 'same' ? '--same' : '', review ? '--review' : '', task].filter(Boolean).join(' ');
      const label = `équipe ${n ? 'de ' + n + ' agents' : "d'agents"}${mode === 'pool' ? ' en parallèle' : mode === 'same' ? ' à la suite' : ''}${review ? ' + relecture' : ''}`;
      return { cmd: '/team', arg, label };
    }
  }
  return null;
}

/** URL(s) http(s) citées dans la demande : leur contenu est joint automatiquement (le modèle n'a pas d'accès web direct). */
export function urlsIn(text) {
  return [...new Set((String(text || '').match(/https?:\/\/[^\s<>"')\]]+/gi) || []).map(u => u.replace(/[.,;:!?]+$/, '')))].slice(0, 2);
}
