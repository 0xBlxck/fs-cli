// Usage du compte et de la conversation (contexte, quota)
import { getJson } from './api.js';

const fmt = n => Number(n || 0).toLocaleString('fr-FR');
const pct = n => `${(Math.round(Number(n || 0) * 10) / 10).toLocaleString('fr-FR')} %`;
const when = iso => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '?');

/** { tokenUsage, contextUsagePercent } d'une conversation, ou null */
export const fetchChatUsage = chatId => (chatId ? getJson(`/chats/${encodeURIComponent(chatId)}/usage`, 6000) : Promise.resolve(null));
/** { rateLimits[], chatBudget, rateLimitPowerUpActive }, ou null */
export const fetchUserUsage = () => getJson('/user/usage', 8000);

/**
 * Contexte MESURÉ par France Student (GET /chats/{id}/context, celui qu'appelle le site) : { usedTokens, contextWindow,
 * usagePercent, categories[] } ou null. usedTokens = ce que le modèle relit à la prochaine requête (consignes du site,
 * outils, règles, conversation) — le vrai chiffre d'entrée : avec Claude, tokenUsage.promptTokenCount ne compte que
 * la petite partie hors cache (≈ 4 par requête).
 */
export async function fetchChatContext(chatId, ms = 4000) {
  if (!chatId) return null;
  const dto = await getJson(`/chats/${encodeURIComponent(chatId)}/context`, ms).catch(() => null);
  const d = dto?.data ?? dto;
  const used = Number(d?.usedTokens);
  return Number.isFinite(used) && used > 0 ? { usedTokens: used, contextWindow: Number(d.contextWindow) || null, usagePercent: Number(d.usagePercent), categories: Array.isArray(d.categories) ? d.categories : [] } : null;
}

/** Pourcentage de contexte utilisé (0-100) ou null */
export async function contextPercent(chatId) {
  const dto = await fetchChatUsage(chatId);
  const v = Number(dto?.contextUsagePercent);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;
}

/**
 * Budget de chat restant du compte (la limite du site qui bloque les messages quand elle est atteinte, ≠ contexte) :
 * { left: 0-100, resetAt } ou null (indisponible, ou pas de réponse en ms millisecondes).
 */
export async function chatBudget(ms = 4000, fetcher = fetchUserUsage) {
  const dto = await Promise.race([fetcher().catch(() => null), new Promise(r => setTimeout(() => r(null), ms).unref?.())]);
  const b = dto?.chatBudget;
  if (!b) return null;
  let left = Number(b.remainingPercent);
  if (!Number.isFinite(left)) left = 100 - Number(b.usedPercent);
  return Number.isFinite(left) ? { left: Math.min(100, Math.max(0, left)), resetAt: b.resetAt || null } : null;
}

/** « 72 % » arrondi (0,4 % → « 0,4 % » : presque vide, pas « 0 % ») */
export const budgetText = left => left > 0 && left < 1 ? `${left.toFixed(1).replace('.', ',')} %` : `${Math.round(left)} %`;

export function describeChatUsage(dto) {
  if (!dto) return ['usage de la conversation indisponible'];
  const t = dto.tokenUsage || {};
  return [`${fmt(t.totalTokenCount)} tokens (prompt ${fmt(t.promptTokenCount)}, réponse ${fmt(t.candidatesTokenCount)}, raisonnement ${fmt(t.reasoningTokenCount)}) · contexte utilisé ${pct(dto.contextUsagePercent)}`];
}

/** Lignes lisibles du quota du compte ; level = 'ok' | 'warn' | 'crit' selon le budget de chat */
export function describeUserUsage(dto) {
  if (!dto) return { lines: ['quota indisponible'], level: 'ok' };
  const lines = [];
  let level = 'ok';
  if (dto.chatBudget) {
    const b = dto.chatBudget, used = Number(b.usedPercent) || 0;
    level = used > 95 ? 'crit' : used > 85 ? 'warn' : 'ok';
    lines.push(`budget de chat : ${pct(used)} utilisé · ${pct(b.remainingPercent)} restant · remise à zéro ${when(b.resetAt)}${level === 'crit' ? '  [CRITIQUE]' : ''}`);
  }
  for (const rl of dto.rateLimits || []) {
    lines.push(`limite ${rl.type ?? '?'} : ${fmt(rl.used)}/${fmt(rl.limit)} (${pct(rl.usedPercent)}) · remise à zéro ${when(rl.resetAt)}`);
  }
  if (dto.rateLimitPowerUpActive) lines.push('power-up actif (limites doublées)');
  return { lines, level };
}
