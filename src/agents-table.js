// Table des modèles (agents) France Student partagée par cli.js, le serveur MCP et la passerelle Claude Code.
// Source de vérité en ligne : GET /chats/agents (api.fetchAgents, api.fetchAgentsFull). Ces valeurs ne servent que de repli.

/** Modèles connus si /chats/agents ne répond pas : { id: nom }. Figé : copier avant de modifier ({ ...FALLBACK_AGENTS }). */
export const FALLBACK_AGENTS = Object.freeze({
  '-1002': 'GPT-6 Luna', '-1003': 'GPT-6.1 Sol', '-1004': 'GPT-6 Astra',
  '-2001': 'Claude Opus 5.5', '-2002': 'Claude Haiku 5.5', '-2003': 'Claude Sonnet 5.5', '-2005': 'Claude Fable 5.2',
});

/** Agent France Student de chaque famille de modèles (nom de modèle Claude Code inconnu → famille, § 3.10 de la passerelle). */
export const FAMILY_AGENT = Object.freeze({ opus: -2001, sonnet: -2003, haiku: -2002, fable: -2005, gpt: -1004 });
