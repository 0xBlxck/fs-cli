// Ordre des modèles, du plus puissant au moins puissant (même règle que le menu du panneau, vscode/media/panel.js) :
//   Claude : Fable > Opus > Sonnet > Haiku (version la plus récente d'abord)
//   GPT    : Astra (modèle phare) d'abord, puis la version la plus récente ; dans une version : Sol > Terra > Luna
//   les fournisseurs restent groupés : Claude, puis OpenAI, puis les autres.

/** clé de tri d'un modèle d'après son nom */
export function modelRank(name) {
  const n = String(name || '').toLowerCase(), ver = parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [])[1]) || 0;
  const claude = ['fable', 'opus', 'sonnet', 'haiku'].findIndex(k => n.includes(k));
  if (claude >= 0 || /claude/.test(n)) return [0, claude < 0 ? 9 : claude, -ver, 0];
  if (/gpt|\bo\d/.test(n)) {
    const tier = ['astra', 'sol', 'terra', 'luna'].findIndex(k => n.includes(k));
    return [1, tier === 0 ? 0 : 1, -ver, tier < 0 ? 9 : tier];
  }
  return [2, 0, -ver, 0];
}

const cmp = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/** identifiants d'une table { id: nom } triés du plus puissant au moins puissant */
export function sortedModelIds(agents) {
  return Object.keys(agents || {}).sort((a, b) => cmp(modelRank(agents[a]), modelRank(agents[b])));
}
