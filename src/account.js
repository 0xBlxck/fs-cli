// Usage du compte et de la conversation (contexte, quota)
import { getJson } from './api.js';

const fmt = n => Number(n || 0).toLocaleString('fr-FR');
const pct = n => `${(Math.round(Number(n || 0) * 10) / 10).toLocaleString('fr-FR')} %`;
const when = iso => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '?');

/** { tokenUsage, contextUsagePercent } d'une conversation, ou null */
export const fetchChatUsage = chatId => (chatId ? getJson(`/chats/${encodeURIComponent(chatId)}/usage`, 6000) : Promise.resolve(null));
/** { rateLimits[], chatBudget, rateLimitPowerUpActive }, ou null */
export const fetchUserUsage = () => getJson('/user/usage', 8000);

/** Pourcentage de contexte utilisé (0-100) ou null */
export async function contextPercent(chatId) {
  const dto = await fetchChatUsage(chatId);
  const v = Number(dto?.contextUsagePercent);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;
}

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
