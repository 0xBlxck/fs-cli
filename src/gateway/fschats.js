// Conversations du site France Student dans Claude Code : liste (--fs-conversations, /fs:conversations) et reprise.

const whenFr = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };

/** ligne d'une conversation : « 3. Titre · modèle · 19/11 15:24 » (withId : l'id à la fin, pour --fs-conversation) */
export function chatLine(c, i, { withId = false } = {}) {
  const parts = [String(c?.title || '(sans titre)').replace(/\s+/g, ' ').slice(0, 60), c?.agent?.name, whenFr(c?.lastMessageAt || c?.createdAt)].filter(Boolean);
  return `${String(i + 1).padStart(3)}. ${parts.join(' · ')}${withId ? `  (${c.id})` : ''}`;
}

/** plus récentes d'abord ; word : seulement celles dont le titre contient ce mot (sans tenir compte de la casse) */
export function pickChats(list, word = '', max = 30) {
  const at = c => String(c?.lastMessageAt || c?.createdAt || '');
  let out = (Array.isArray(list) ? list : []).filter(c => c?.id).sort((a, b) => at(b).localeCompare(at(a)));
  const low = String(word || '').trim().toLocaleLowerCase('fr-FR');
  if (low) out = out.filter(c => String(c.title || '').toLocaleLowerCase('fr-FR').includes(low));
  return out.slice(0, max);
}

export const isChatId = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '').trim());

/** Marqueur posé par les commandes du plugin de session (commands/*.md) : « FSCLI-COMMANDE <nom> <arguments> ». */
export const COMMAND_MARK = 'FSCLI-COMMANDE';
export function fsCommand(text) {
  const m = String(text || '').match(/FSCLI-COMMANDE (conversations|reprendre)\b[ \t]*([^\n]*)/);
  return m ? { name: m[1], arg: m[2].trim() } : null;
}

/** Fichiers du plugin chargé pour la session par fs-cli claude (--plugin-dir) : { chemin relatif: contenu } */
export function pluginFiles(version = '0.0.0') {
  return {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'fs', version, description: 'Conversations France Student dans Claude Code (FS-CLI)' }, null, 2) + '\n',
    'commands/conversations.md': [
      '---',
      'description: Liste tes conversations France Student (un mot pour filtrer les titres) · FS-CLI',
      'argument-hint: [mot du titre]',
      '---',
      `${COMMAND_MARK} conversations $ARGUMENTS`,
      '',
    ].join('\n'),
    'commands/reprendre.md': [
      '---',
      'description: Continue ici une conversation France Student (numéro de /fs:conversations, mot du titre ou id)',
      'argument-hint: <numéro | mot du titre | id>',
      '---',
      `${COMMAND_MARK} reprendre $ARGUMENTS`,
      '',
    ].join('\n'),
  };
}
