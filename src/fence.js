// Ligne d'ouverture d'un bloc de code : langage + nom de fichier éventuel (les chemins avec ESPACES sont acceptés)
//   ```html index.html            → { lang: 'html', name: 'index.html' }
//   ```html HTML SITE\index.html  → { lang: 'html', name: 'HTML SITE\index.html' }
//   ```python title="mon script.py" → { lang: 'python', name: 'mon script.py' }
//   ```notes.txt                  → { lang: 'notes.txt', name: 'notes.txt', fileFirst: true }
export const FILE_TOKEN = /^[\w.\/\\:-]+\.[A-Za-z0-9]{1,6}$/;
export const PATH_WITH_SPACES = /^((?:[A-Za-z]:)?[\w .\/\\()+~-]*[\w)]\.[A-Za-z0-9]{1,6})$/;

export const isFilePath = s => FILE_TOKEN.test(s) || PATH_WITH_SPACES.test(s);

export function parseFenceInfo(info) {
  const m = /^(\S*)\s*([\s\S]*)$/.exec((info || '').trim());
  const first = m[1] || '';
  let rest = (m[2] || '').trim();
  rest = rest.replace(/^(?:title|file|filename|path|name)\s*[:=]\s*/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  if (FILE_TOKEN.test(first)) return { lang: first, name: first, fileFirst: true };
  if (rest) {
    const p = PATH_WITH_SPACES.exec(rest);
    if (p) return { lang: first, name: p[1].trim() };
  }
  return { lang: first, name: '' };
}

/** nom de fichier cité juste avant un bloc : `index.html`, **style.css**, `HTML SITE\index.html` */
export function captionFile(line) {
  const m = /`([^`\n]+?\.[A-Za-z0-9]{1,6})`|\*\*([^*\n]+?\.[A-Za-z0-9]{1,6})\*\*/.exec(line || '');
  const cand = (m && (m[1] || m[2]) || '').trim();
  return cand && isFilePath(cand) ? cand : null;
}
