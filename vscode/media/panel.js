// Panneau de chat FS-CLI (webview). Reçoit les événements de « fs-cli --stdio » via l'extension.
// Tout texte venant du modèle ou des commandes est échappé : aucun HTML de l'extérieur n'est interprété.
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();

  // ── utilitaires DOM ──
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const post = m => vscode.postMessage(m);
  const ICON = {
    plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>',
    slash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M9.8 5L6.2 11"/></svg>',
    send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>',
    stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
    hist: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.6"/></svg>',
    neu: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M13.5 8.5V13a1 1 0 01-1 1H3a1 1 0 01-1-1V3.5a1 1 0 011-1h4.5"/><path d="M11 2.5l2.5 2.5L8 10.5H5.5V8z"/></svg>',
    ctx: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" width="12" height="12"><rect x="2.5" y="4.5" width="8" height="9" rx="1"/><path d="M5.5 4.5V3a.5.5 0 01.5-.5h7a.5.5 0 01.5.5v8a.5.5 0 01-.5.5h-2.5"/></svg>',
  };
  const MODE_UI = { auto: '⚡ Auto', edits: '✎ Modifs auto', ask: '✋ Confirmer', plan: '◇ Plan' };
  const CMD_DESC = {
    '/new': 'nouvelle conversation', '/resume': 'reprendre une conversation', '/model': 'changer de modèle', '/mode': 'changer de mode',
    '/plan': 'une demande en lecture seule', '/changes': 'fichiers modifiés : diff, annuler', '/rewind': 'revenir avant une demande', '/undo': 'annuler la dernière modification',
    '/usage': 'consommation du compte', '/context': 'taille du contexte', '/compact': 'résumer pour libérer du contexte', '/messages': 'réafficher les messages',
    '/team': 'plusieurs agents sur une tâche', '/compare': 'deux modèles, même question', '/navigateur': 'piloter le navigateur', '/mcp': 'serveurs MCP',
    '/skills': 'skills installés', '/remember': 'retenir une info', '/memory': 'mémoire', '/init': 'créer FSCLI.md', '/doctor': 'vérifier l\'installation',
    '/help': 'toutes les commandes', '/status': 'état de la session', '/web': 'recherche web on/off', '/copy': 'copier la dernière réponse', '/image': 'joindre une image',
    '/search': 'recherche web', '/fetch': 'lire une page web', '/history': 'conversations récentes', '/permissions': 'règles de sécurité', '/think': 'afficher le raisonnement',
  };

  // ── état ──
  const S = { models: [], modes: [], commands: [], status: {}, busy: false, ctx: null, ctxOn: true, ai: null, tool: null, explore: null, spin: null, tasks: [], tasksMin: false, menu: null, ask: null, started: false };

  // ── structure ──
  const app = document.getElementById('app');
  const head = h('div', 'head');
  const title = h('div', 'title', 'FS-CLI');
  const btnHist = h('button', 'icon-btn'); btnHist.innerHTML = ICON.hist; btnHist.title = 'Conversations précédentes';
  const btnNew = h('button', 'icon-btn'); btnNew.innerHTML = ICON.neu; btnNew.title = 'Nouvelle conversation';
  const btnMcp = h('button', 'icon-btn'); btnMcp.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 01-7 0zM8 11v3"/></svg>'; btnMcp.title = 'Serveurs MCP';
  btnMcp.onclick = () => { if (!S.busy) post({ type: 'command', text: '/mcp' }); };
  const btnUse = h('button', 'icon-btn'); btnUse.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5"/></svg>'; btnUse.title = 'Compte & consommation';
  btnUse.onclick = () => { if (!S.busy) post({ type: 'command', text: '/usage' }); };
  head.append(title, btnUse, btnMcp, btnHist, btnNew);
  const log = h('div', 'log');
  const tasksEl = h('div', 'tasks'); tasksEl.hidden = true;
  const composer = h('div', 'composer');
  const flash = h('div', 'flash'); flash.style.opacity = '0';
  const box = h('div', 'box');
  const ctxbar = h('div', 'ctxbar');
  const chip = h('div', 'chip'); chip.title = 'Joint au message — clic pour ne pas l\'envoyer';
  ctxbar.append(chip); ctxbar.hidden = true;
  const ta = h('textarea'); ta.rows = 1; ta.placeholder = 'Demande quelque chose à FS-CLI…  (/ pour les commandes)';
  const tools = h('div', 'tools');
  const bPlus = h('button', 'icon-btn'); bPlus.innerHTML = ICON.plus; bPlus.title = 'Joindre des fichiers ou images';
  const bSlash = h('button', 'icon-btn'); bSlash.innerHTML = ICON.slash; bSlash.title = 'Commandes';
  const bModel = h('button', 'pill model', '…'); bModel.title = 'Modèle';
  const bMode = h('button', 'pill', MODE_UI.auto); bMode.title = 'Mode (Maj+Tab)';
  const bSend = h('button', 'send'); bSend.innerHTML = ICON.send; bSend.title = 'Envoyer (Entrée)';
  tools.append(bPlus, bSlash, bModel, h('div', 'spacer'), bMode, bSend);
  box.append(ctxbar, ta, tools);
  const foot = h('div', 'foot'); const footL = h('span'); const footR = h('span'); foot.append(footL, footR);
  composer.append(flash, box, foot);
  app.append(head, log, tasksEl, composer);

  // ── défilement : reste en bas si on y était ──
  let stick = true;
  log.addEventListener('scroll', () => { stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40; });
  const toBottom = () => { if (stick) log.scrollTop = log.scrollHeight; };
  const add = el => { if (S.spin && S.spin.el.parentNode === log) log.insertBefore(el, S.spin.el); else log.append(el); welcomeOff(); toBottom(); return el; };

  // ── accueil ──
  let welcome = null;
  function showWelcome() {
    log.textContent = ''; welcome = h('div', 'welcome');
    welcome.innerHTML = '<h1>FS-CLI</h1><div>L\'agent France Student AI dans ton éditeur. Il lit et modifie ton projet ; tu valides ce qui est sensible.</div>';
    const logo = h('img', 'logo'); logo.src = document.body.dataset.logo || ''; logo.alt = 'France Student'; welcome.prepend(logo);
    const tips = h('div', 'tips');
    for (const [t, d] of [['Explique-moi ce projet', 'il lit les fichiers et résume'], ['Corrige les erreurs de ce fichier', 'sélectionne du code : il est joint au message'], ['/plan ajoute une page de contact', 'il propose un plan avant de toucher aux fichiers']]) {
      const tip = h('div', 'tip', t); tip.append(h('small', null, d));
      tip.onclick = () => { ta.value = t; autosize(); ta.focus(); };
      tips.append(tip);
    }
    welcome.append(tips); log.append(welcome);
  }
  function welcomeOff() { if (welcome) { welcome.remove(); welcome = null; } }

  // ── markdown (sous-ensemble GFM), toujours échappé ──
  const codeStore = [];
  function inline(src) {
    const keep = [];
    const stash = html => `\u0000${keep.push(html) - 1}\u0000`;
    let s = String(src).replace(/`([^`\n]+)`/g, (_, code) => {
      const isPath = /^[\w./\\:-]+\.[A-Za-z0-9]{1,8}(:\d+)?$/.test(code) && /[/\\.]/.test(code);
      return stash(isPath ? `<code><a data-path="${esc(code)}">${esc(code)}</a></code>` : `<code>${esc(code)}</code>`);
    });
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => stash(`<a data-url="${esc(u)}" title="${esc(u)}">${esc(t)}</a>`));
    s = s.replace(/https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g, u => stash(`<a data-url="${esc(u)}">${esc(u)}</a>`));
    s = esc(s);
    s = s.replace(/\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g, (_, a, b) => `<strong>${a || b}</strong>`);
    s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
  }
  function md(src, streaming) {
    const L = String(src).replace(/\r/g, '').split('\n');
    let out = '', para = [], i = 0;
    const flush = () => { if (para.length) { out += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
    while (i < L.length) {
      const l = L[i];
      const fence = l.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/);
      if (fence) {
        flush();
        const tick = fence[1], body = []; i++;
        while (i < L.length && !(L[i].trim().startsWith(tick[0].repeat(tick.length)) && /^\s*[`~]+\s*$/.test(L[i]))) body.push(L[i++]);
        const closed = i < L.length; i++;
        const id = codeStore.push(body.join('\n')) - 1;
        const name = [fence[2], fence[3]].filter(Boolean).join(' ');
        out += `<div class="code"><div class="bar"><span>${esc(name || 'code')}</span><button data-copy="${id}">Copier</button></div><pre><code>${esc(body.join('\n'))}${!closed && streaming ? '' : ''}</code></pre></div>`;
        continue;
      }
      let m;
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flush(); const n = Math.min(4, m[1].length); out += `<h${n}>${inline(m[2])}</h${n}>`; i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out += '<hr>'; i++; continue; }
      if (/^\s*>/.test(l)) { flush(); const q = []; while (i < L.length && /^\s*>/.test(L[i])) q.push(L[i++].replace(/^\s*>\s?/, '')); out += `<blockquote>${md(q.join('\n'))}</blockquote>`; continue; }
      if (l.includes('|') && i + 1 < L.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(L[i + 1])) {
        flush();
        const cells = r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim());
        const hd = cells(l); i += 2;
        let t = '<table><thead><tr>' + hd.map(x => `<th>${inline(x)}</th>`).join('') + '</tr></thead><tbody>';
        while (i < L.length && L[i].includes('|') && L[i].trim()) { t += '<tr>' + cells(L[i]).map(x => `<td>${inline(x)}</td>`).join('') + '</tr>'; i++; }
        out += t + '</tbody></table>'; continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        flush();
        const items = [];
        while (i < L.length) {
          const mm = L[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (mm) { items.push({ ind: mm[1].replace(/\t/g, '    ').length, ord: /\d/.test(mm[2]), text: mm[3] }); i++; continue; }
          if (L[i].trim() && /^\s{2,}/.test(L[i]) && items.length) { items[items.length - 1].text += '\n' + L[i].trim(); i++; continue; }
          break;
        }
        const stack = [];
        for (const it of items) {
          while (stack.length && it.ind < stack[stack.length - 1].ind) out += `</li></${stack.pop().tag}>`;
          const top = stack[stack.length - 1];
          if (!top || it.ind > top.ind) { const tag = it.ord ? 'ol' : 'ul'; stack.push({ ind: it.ind, tag }); out += `<${tag}>`; }
          else out += '</li>';
          const task = it.text.match(/^\[([ xX])\]\s+(.*)$/s);
          out += task ? `<li class="task">${task[1] === ' ' ? '☐' : '☒'} ${inline(task[2])}` : `<li>${it.text.split('\n').map(inline).join('<br>')}`;
        }
        while (stack.length) out += `</li></${stack.pop().tag}>`;
        continue;
      }
      if (!l.trim()) { flush(); i++; continue; }
      para.push(l); i++;
    }
    flush();
    return out;
  }

  // ── ANSI (lignes d'information du CLI) → DOM, couleurs via CSSOM (aucun style en ligne) ──
  const BASIC = ['#555', '#f06969', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#ccc'];
  function ansi(text) {
    const frag = document.createDocumentFragment();
    let st = {};
    const re = /\x1b\[([0-9;]*)m/g; let last = 0, m;
    const emit = s => { if (!s) return; const sp = h('span', [st.b && 'b', st.i && 'i', st.s && 's', st.d && 'd'].filter(Boolean).join(' ') || null, s); if (st.fg) sp.style.color = st.fg; if (st.bg) sp.style.background = st.bg; frag.append(sp); };
    while ((m = re.exec(text))) {
      emit(text.slice(last, m.index)); last = re.lastIndex;
      const p = m[1] ? m[1].split(';').map(Number) : [0];
      for (let k = 0; k < p.length; k++) {
        const v = p[k];
        if (v === 0) st = {}; else if (v === 1) st.b = 1; else if (v === 2) st.d = 1; else if (v === 3) st.i = 1; else if (v === 9) st.s = 1;
        else if (v === 22) { st.b = 0; st.d = 0; } else if (v === 23) st.i = 0; else if (v === 29) st.s = 0; else if (v === 39) st.fg = null; else if (v === 49) st.bg = null;
        else if ((v === 38 || v === 48) && p[k + 1] === 2) { const col = `rgb(${p[k + 2]},${p[k + 3]},${p[k + 4]})`; if (v === 38) st.fg = col; else st.bg = col; k += 4; }
        else if ((v === 38 || v === 48) && p[k + 1] === 5) k += 2;
        else if (v >= 30 && v <= 37) st.fg = BASIC[v - 30]; else if (v >= 90 && v <= 97) st.fg = BASIC[v - 90];
      }
    }
    emit(text.slice(last).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
    return frag;
  }

  // ── réponse du modèle (flux) ──
  let raf = 0;
  function renderAI(final) {
    raf = 0;
    if (!S.ai) return;
    S.ai.el.innerHTML = md(S.ai.text, !final) || '';
    if (!final) S.ai.el.classList.add('cursor'); else S.ai.el.classList.remove('cursor');
    toBottom();
  }
  function aiText(delta) {
    thinkEnd();
    if (!S.ai) { S.ai = { el: add(h('div', 'tl msg-ai')), text: '' }; S.tool = null; }
    S.ai.text += delta;
    if (!raf) raf = requestAnimationFrame(() => renderAI(false));
  }
  function aiEnd() {
    if (!S.ai) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!S.ai.text.trim()) S.ai.el.remove(); else renderAI(true);
    S.ai = null;
  }

  // ── actions de l'agent : style « fil » (puce + nom de l'outil en gras + boîte IN / OUT), comme Claude Code ──
  const TOOL_NAME = { python: 'Python', read_file: 'Read', write_file: 'Write', edit_file: 'Edit', list_dir: 'List', grep: 'Grep', glob: 'Glob', fetch_url: 'Fetch', web_search: 'Search' };
  const PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_dir']);
  const IN_TOOLS = new Set(['shell', 'python']);
  function firstPath(detail) { const m = String(detail || '').match(/^"([^"]+)"|^(\S+)/); return m ? (m[1] || m[2]) : ''; }
  function shellName() { const s = String(S.shell || ''); return /powershell|pwsh/i.test(s) ? 'PowerShell' : /bash|zsh|sh\b/i.test(s) ? 'Bash' : /cmd/i.test(s) ? 'Cmd' : 'Shell'; }
  function lastContent() { let el = log.lastElementChild; if (S.spin && el === S.spin.el) el = el.previousElementSibling; return el; }

  /** boîte IN / OUT : texte replié sur 3 lignes avec fondu, clic pour tout voir */
  function ioBox(t) {
    if (!t.box) { t.box = h('div', 'io'); t.el.append(t.box); }
    return t.box;
  }
  function ioRow(t, kind) {
    const box = ioBox(t);
    let row = box.querySelector(`.io-row.${kind}`);
    if (!row) {
      row = h('div', 'io-row ' + kind);
      const pre = h('pre', 'io-text');
      row.append(h('span', 'io-k', kind === 'in' ? 'IN' : 'OUT'), pre);
      row.onclick = () => { if (pre.scrollHeight > pre.clientHeight + 2 || row.classList.contains('open')) row.classList.toggle('open'); };
      if (kind === 'in') box.prepend(row); else box.append(row);
    }
    return row;
  }
  function setIo(t, kind, text, { append = false, error = false } = {}) {
    const row = ioRow(t, kind), pre = row.querySelector('pre');
    if (append) pre.textContent += (pre.textContent ? '\n' : '') + text; else pre.textContent = text;
    if (error) row.classList.add('error');
    row.classList.toggle('long', pre.textContent.split('\n').length > 3 || pre.textContent.length > 400);
    toBottom();
  }

  function toolStart(ev) {
    aiEnd(); thinkEnd();
    const el = h('div', 'tl tool running');
    const head = h('div', 'th');
    const mcp = ev.tag === 'MCP';
    const name = mcp ? 'MCP' : ev.name === 'shell' ? shellName() : (TOOL_NAME[ev.name] || ev.label || ev.name);
    head.append(h('b', null, name));
    const p = PATH_TOOLS.has(ev.name) ? firstPath(ev.detail) : '';
    if (p) {
      const a = h('a', 'tp', p); a.title = 'Ouvrir ' + p;
      a.onclick = e => { e.stopPropagation(); post({ type: 'openFile', path: p }); };
      head.append(' ', a);
      const rest = String(ev.detail || '').slice(String(ev.detail || '').indexOf(p) + p.length).trim();
      if (rest) head.append(' ', h('span', 'td', rest));
    } else if (mcp) head.append(' ', h('span', 'td', ev.label));
    else if (!IN_TOOLS.has(ev.name) && ev.detail) head.append(' ', h('span', 'td', ev.detail));
    el.append(head);
    const t = { el, name: ev.name, path: p, box: null };
    S.tool = t;
    add(el);
    const input = mcp ? ev.detail : IN_TOOLS.has(ev.name) ? (ev.raw || ev.detail) : '';
    if (input) setIo(t, 'in', input);
  }
  function toolOut(text, error, append) {
    const t = S.tool;
    if (!t) { const p = h('div', 'print'); p.textContent = text; add(p); return; }
    const row = t.box?.querySelector('.io-row.out');
    if (!append && row && row.querySelector('pre').textContent && !error) return;     // sortie déjà affichée en direct
    setIo(t, 'out', text, { append, error });
  }
  function toolDone(ok) {
    const t = S.tool; if (!t) return;
    t.el.classList.remove('running'); t.el.classList.add(ok ? 'ok' : 'err');
  }
  function note(text, kind) {
    const t = S.tool;
    if (t && t.box && !t.box.querySelector('.io-row.out') && kind !== 'red' && kind !== 'yellow' && IN_TOOLS.has(t.name)) { setIo(t, 'out', text); return; }
    if (t && (kind === 'dim' || !kind) && !IN_TOOLS.has(t.name)) { t.el.querySelector('.th').append(' ', h('span', 'td', '· ' + text)); return; }
    const n = h('div', 'tnote ' + (kind || ''), text);
    if (t) { t.el.append(n); toBottom(); } else { const w = h('div', 'tl'); w.append(n); add(w); }
  }
  function diff(ev) {
    const t = S.tool;
    const d = h('div', 'diff');
    const dh = h('div', 'dh');
    dh.append(h('span', 'a', `+${ev.added}`), ' ', h('span', 'r', `−${ev.removed}`));
    if (t && t.path) { const a = h('a', null, 'ouvrir le diff dans l\'éditeur'); a.onclick = () => post({ type: 'openDiff', path: t.path }); dh.append(h('span', 'sp'), a); }
    const body = h('div', 'body');
    for (const l of ev.lines || []) {
      if (!l) { body.append(h('div', 'gap', '⋮')); continue; }
      const row = h('div', 'l' + (l.t === '+' ? ' add' : l.t === '-' ? ' del' : ''));
      row.append(h('span', 'n', String(l.n ?? '')), h('span', 's', l.t === ' ' ? '' : l.t), h('span', null, l.line));
      body.append(row);
    }
    d.append(dh, body);
    if (t) { t.el.append(d); toBottom(); } else { const w = h('div', 'tl'); w.append(d); add(w); }
  }

  // ── raisonnement du modèle : « Thinking… » puis « Thought for 12s » (clic pour le lire) ──
  function thinking(delta) {
    if (!S.think) {
      aiEnd();
      const el = h('div', 'tl think running');
      const head = h('div', 'th'); const lab = h('span', null, 'Thinking…');
      head.append(lab);
      const body = h('pre', 'think-body'); body.hidden = true;
      head.onclick = () => { body.hidden = !body.hidden; toBottom(); };
      el.append(head, body);
      S.think = { el, lab, body, t0: Date.now() };
      add(el);
    }
    S.think.body.textContent += delta;
  }
  function thinkEnd() {
    const k = S.think; if (!k) return;
    S.think = null;
    k.el.classList.remove('running');
    const s = Math.max(1, Math.round((Date.now() - k.t0) / 1000));
    k.lab.textContent = `Thought for ${s}s`;
  }

  function endExplore() { thinkEnd(); }

  // ── bilan des fichiers ──
  function changes(files) {
    aiEnd(); endExplore();
    const el = h('div', 'tl ok changes');
    const add_ = files.reduce((n, f) => n + (f.added || 0), 0), rem = files.reduce((n, f) => n + (f.removed || 0), 0);
    const ch = h('div', 'ch'); ch.append(h('span', null, `Fichiers modifiés · ${files.length}`), h('span', 'a', add_ ? `+${add_}` : ''), h('span', 'r', rem ? `−${rem}` : ''));
    el.append(ch);
    for (const f of files) {
      const row = h('div', 'f'); row.dataset.path = f.path;
      const p = h('span', 'p', (f.created ? '＋ ' : '✎ ') + (f.rel && !f.rel.startsWith('..') ? f.rel : f.path)); p.title = 'Voir le diff dans l\'éditeur';
      p.onclick = () => post({ type: 'openDiff', path: f.path });
      const u = h('button', 'undo', 'Annuler'); u.title = f.created ? 'Retirer ce fichier (il part dans la corbeille de FS-CLI)' : 'Remettre ce fichier dans son état d\'avant';
      u.onclick = () => post({ type: 'undoFile', path: f.path });
      row.append(p, h('span', 'a', f.binary ? '' : f.added ? `+${f.added}` : ''), h('span', 'r', f.removed ? `−${f.removed}` : ''), u);
      el.append(row);
    }
    add(el);
  }

  // ── questions (confirmations, menus) ──
  function selectCard(ev) {
    aiEnd(); endExplore();
    const el = h('div', 'ask'); el.tabIndex = 0;
    el.append(h('div', 'q', ev.title));
    if (ev.detail) el.append(h('div', 'detail', ev.detail));
    const opts = h('div', 'opts'); el.append(opts);
    let sel = Math.max(0, ev.defaultIndex || 0);
    const btns = ev.options.map((o, i) => { const b = h('button', 'opt'); b.append(h('span', 'k', String(i + 1)), h('span', null, o)); b.onclick = () => answer(i); opts.append(b); return b; });
    const paint = () => btns.forEach((b, i) => b.classList.toggle('sel', i === sel));
    paint();
    el.append(h('div', 'hint', '↑↓ puis Entrée · 1-9 · Échap pour refuser'));
    const answer = i => {
      if (S.ask !== card) return;
      S.ask = null;
      post({ type: 'select', id: ev.id, index: i == null ? -1 : i });
      el.className = 'tl answered'; el.textContent = i == null ? '✗ refusé' : `✓ ${ev.options[i]}`;
      ta.focus();
    };
    const card = { el, key: e => {
      if (e.key === 'ArrowDown') { sel = (sel + 1) % btns.length; paint(); }
      else if (e.key === 'ArrowUp') { sel = (sel - 1 + btns.length) % btns.length; paint(); }
      else if (e.key === 'Enter') answer(sel);
      else if (e.key === 'Escape') answer(null);
      else if (/^[1-9]$/.test(e.key) && +e.key <= btns.length) answer(+e.key - 1);
      else return false;
      e.preventDefault(); return true;
    } };
    S.ask = card; add(el); el.focus();
  }
  function askCard(ev) {
    aiEnd(); endExplore();
    const el = h('div', 'ask');
    el.append(h('div', 'q', ev.label || 'Réponse :'));
    const inp = h('input'); el.append(inp);
    const done = v => { if (S.ask !== card) return; S.ask = null; post({ type: 'ask', id: ev.id, text: v }); el.className = 'tl answered'; el.textContent = `✓ ${v || '(vide)'}`; ta.focus(); };
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(inp.value); } else if (e.key === 'Escape') { e.preventDefault(); done(''); } };
    const card = { el, key: () => false };
    S.ask = card; add(el); inp.focus();
  }
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || !S.ask) return;                          // touche déjà traitée (ex. Entrée qui envoie un message) : jamais une réponse
    if (document.activeElement === S.ask.el || document.activeElement === document.body) S.ask.key(e);
  });

  // ── indicateur d'attente ──
  const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  function spinner(label) {
    if (!label) { if (S.spin) { clearInterval(S.spin.timer); S.spin.el.remove(); S.spin = null; } return; }
    if (!S.spin) {
      const el = h('div', 'tl spin'); const f = h('span', 'f', '✻'); const l = h('b'); const t = h('span', 't');
      el.append(f, l, t);
      S.spin = { el, f, l, t, i: 0, t0: S.spinT0 || Date.now() };
      S.spin.timer = setInterval(() => { const s = S.spin; if (!s) return; s.f.textContent = FRAMES[Math.floor(s.i++ / 1.5) % FRAMES.length]; const sec = Math.floor((Date.now() - s.t0) / 1000); s.t.textContent = `${sec < 60 ? sec + ' s' : Math.floor(sec / 60) + ' min ' + (sec % 60) + ' s'} · Échap pour interrompre`; }, 90);
      log.append(el);
    }
    S.spin.l.textContent = label; toBottom();
  }

  // ── tâches ──
  function renderTasks() {
    const L = S.tasks || [];
    tasksEl.hidden = !L.length;
    if (!L.length) return;
    tasksEl.textContent = '';
    tasksEl.classList.toggle('min', S.tasksMin);
    const done = L.filter(t => t.state === 'done').length;
    const th = h('div', 'th'); th.append(h('span', null, `Tâches · ${done}/${L.length}`), h('span', null, S.tasksMin ? '▴' : '▾'));
    th.onclick = () => { S.tasksMin = !S.tasksMin; renderTasks(); };
    tasksEl.append(th);
    for (const t of L) { const r = h('div', 't ' + (t.state || '')); r.append(h('span', 'g', t.state === 'done' ? '☒' : t.state === 'doing' ? '◐' : '☐'), h('span', null, t.text)); tasksEl.append(r); }
  }

  // ── barre d'état ──
  function renderStatus() {
    const st = S.status;
    title.textContent = st.title ? st.title : 'FS-CLI';
    bModel.textContent = st.model || '…';
    bMode.textContent = MODE_UI[st.mode] || st.mode || '';
    bMode.className = 'pill mode-' + (st.mode || 'auto');
    const dir = String(st.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
    footL.textContent = [dir ? `📁 ${dir}` : '', st.project ? `◆ projet ${st.project}` : ''].filter(Boolean).join('  ·  ');
    footR.textContent = typeof st.ctx === 'number' ? `contexte ${Math.round(st.ctx)} %` : '';
  }
  function setBusy(b) {
    S.busy = b;
    bSend.innerHTML = b ? ICON.stop : ICON.send; bSend.title = b ? 'Interrompre (Échap)' : 'Envoyer (Entrée)';
    if (b) { S.spinT0 = Date.now(); const q = log.querySelector('.msg-user.queued'); if (q) q.classList.remove('queued'); }
    else { spinner(null); aiEnd(); thinkEnd(); S.tool = null; }
  }
  let flashT = 0;
  function showFlash(text) { flash.textContent = text; flash.style.opacity = '1'; clearTimeout(flashT); flashT = setTimeout(() => { flash.style.opacity = '0'; }, 3500); }

  function notice(text, kind, buttons) {
    const n = h('div', 'notice ' + (kind || '')); n.append(h('div', null, text));
    if (buttons?.length) { const b = h('div', 'btns'); for (const [label, fn, sec] of buttons) { const x = h('button', 'btn' + (sec ? ' sec' : ''), label); x.onclick = fn; b.append(x); } n.append(b); }
    add(n);
  }

  // ── menus (commandes, modèles, modes) ──
  function closeMenu() { if (S.menu) { S.menu.el.remove(); S.menu = null; } }
  function openMenu(items, onPick, { filter = null } = {}) {
    closeMenu();
    if (!items.length) return;
    const el = h('div', 'menu');
    let sel = Math.max(0, items.findIndex(x => x.cur));
    const rows = items.map((it, i) => {
      if (it.section) { const s = h('div', 'sec', it.section); el.append(s); return null; }
      const r = h('div', 'mi' + (it.cur ? ' cur' : '')); r.append(h('span', null, it.label)); if (it.desc) r.append(h('span', 'd', it.desc));
      r.onmousedown = e => { e.preventDefault(); closeMenu(); onPick(it); };
      el.append(r); return r;
    });
    const pickable = rows.map((r, i) => (r ? i : -1)).filter(i => i >= 0);
    if (!rows[sel]) sel = pickable[0];
    const paint = () => rows.forEach((r, i) => r && r.classList.toggle('sel', i === sel));
    paint();
    S.menu = { el, filter, key: e => {
      const k = pickable.indexOf(sel);
      if (e.key === 'ArrowDown') { sel = pickable[(k + 1) % pickable.length]; paint(); rows[sel].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { sel = pickable[(k - 1 + pickable.length) % pickable.length]; paint(); rows[sel].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter' || e.key === 'Tab') { const it = items[sel]; closeMenu(); onPick(it); }
      else if (e.key === 'Escape') closeMenu();
      else return false;
      e.preventDefault(); return true;
    } };
    composer.append(el);
  }
  function slashMenu() {
    const m = ta.value.match(/^\/(\S*)$/);
    if (!m) { if (S.menu?.filter) closeMenu(); return; }
    const q = m[1].toLowerCase();
    const list = (S.commands.length ? S.commands : Object.keys(CMD_DESC)).filter(c => c.slice(1).toLowerCase().startsWith(q));
    list.sort((a, b) => (CMD_DESC[b] ? 1 : 0) - (CMD_DESC[a] ? 1 : 0));
    if (!list.length) return closeMenu();
    openMenu(list.slice(0, 40).map(c => ({ label: c, desc: CMD_DESC[c] || '' })), it => { ta.value = it.label + ' '; autosize(); ta.focus(); }, { filter: true });
  }
  function modelMenu() {
    if (S.menu && !S.menu.filter) return closeMenu();
    openMenu(S.models.map(m => ({ label: m.name, id: m.id, cur: String(m.id) === String(S.status.modelId) })), it => post({ type: 'setModel', id: it.id }));
  }
  function modeMenu() {
    if (S.menu && !S.menu.filter) return closeMenu();
    const modes = S.modes.length ? S.modes : Object.keys(MODE_UI).map(id => ({ id }));
    openMenu(modes.map(m => ({ label: MODE_UI[m.id] || m.id, desc: (m.desc || '').replace(/^mode [^:]+:\s*/, ''), id: m.id, cur: m.id === S.status.mode })), it => post({ type: 'setMode', mode: it.id }));
  }
  function cycleMode() {
    const ids = (S.modes.length ? S.modes.map(m => m.id) : Object.keys(MODE_UI));
    const next = ids[(ids.indexOf(S.status.mode) + 1) % ids.length];
    post({ type: 'setMode', mode: next });
  }

  // ── saisie ──
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px'; }
  function send() {
    const text = ta.value;
    if (!text.trim()) return;
    if (/^\s*\/(usage|mcp|resume|sessions|history|skills|commands)\s*$/i.test(text) && !S.busy) {   // ces commandes ouvrent une fenêtre : rien dans le fil
      ta.value = ''; autosize(); closeMenu();
      if (/resume|sessions|history/i.test(text)) return histOpen();
      if (/skills|commands/i.test(text)) return skOpen();
      return post({ type: 'command', text: text.trim() });
    }
    closeMenu();
    const el = h('div', 'msg-user' + (S.busy ? ' queued' : ''), text);
    if (S.ctxOn && S.ctx && !/^\s*[/!]/.test(text)) el.append(h('div', 'ctx', '⧉ ' + chipText(S.ctx)));
    aiEnd(); endExplore(); S.tool = null;
    stick = true;
    add(h('div', 'when', new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })));
    add(el);
    post({ type: 'send', text });
    ta.value = ''; autosize();
  }
  ta.addEventListener('input', () => { autosize(); slashMenu(); });
  ta.addEventListener('keydown', e => {
    if (S.menu && S.menu.key(e)) return;
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape' && S.busy) { e.preventDefault(); post({ type: 'interrupt' }); }
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta && S.menu?.filter) closeMenu(); }, 150));
  ta.addEventListener('paste', e => {
    const items = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && /^image\//.test(i.type));
    if (!items.length) return;
    e.preventDefault();
    for (const it of items) {
      const f = it.getAsFile(); if (!f) continue;
      const r = new FileReader();
      r.onload = () => { const data = String(r.result).split(',')[1] || ''; post({ type: 'pasteImage', mime: f.type, data }); };
      r.readAsDataURL(f);
    }
  });
  box.addEventListener('dragover', e => e.preventDefault());
  box.addEventListener('drop', e => {
    const uris = (e.dataTransfer?.getData('text/uri-list') || '').split(/\r?\n/).filter(u => /^file:/.test(u));
    if (!uris.length) return;
    e.preventDefault();
    const win = navigator.platform.startsWith('Win');
    const paths = uris.map(u => {
      try {
        const url = new URL(u); let p = decodeURIComponent(url.pathname);
        if (win) { p = p.replace(/^\/([a-zA-Z]:)/, '$1').replace(/\//g, '\\'); if (url.host) p = '\\\\' + url.host + p; }   // C:\… ou \\serveur\partage\…
        return p;
      } catch { return ''; }
    }).filter(Boolean);
    insert(paths.map(p => '@' + (p.includes(' ') ? `"${p}"` : p)).join(' ') + ' ');
  });
  function insert(text) { const s = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, s) + text + ta.value.slice(ta.selectionEnd ?? s); ta.selectionStart = ta.selectionEnd = s + text.length; autosize(); ta.focus(); }

  bSend.onclick = () => (S.busy && !ta.value.trim() ? post({ type: 'interrupt' }) : send());
  bPlus.onclick = () => post({ type: 'pickFiles' });
  bSlash.onclick = skOpen;
  bSlash.title = 'Commandes & skills';
  bModel.onclick = modelMenu;
  bMode.onclick = modeMenu;
  btnNew.onclick = () => { if (!S.busy) post({ type: 'send', text: '/new' }); };
  btnHist.onclick = histOpen;
  chip.onclick = () => post({ type: 'toggleContext' });
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-url], a[data-path], button[data-copy]');
    if (!a) { if (S.menu && !e.target.closest('.menu, .pill')) closeMenu(); return; }
    e.preventDefault();
    if (a.dataset.url) post({ type: 'openLink', url: a.dataset.url });
    else if (a.dataset.path) { const m = a.dataset.path.match(/^(.*?)(?::(\d+))?$/); post({ type: 'openFile', path: m[1], line: m[2] ? +m[2] : 0 }); }
    else if (a.dataset.copy) { post({ type: 'copy', text: codeStore[+a.dataset.copy] || '' }); a.textContent = 'Copié ✓'; setTimeout(() => { a.textContent = 'Copier'; }, 1500); }
  });

  function chipText(c) { return c.start ? `${c.rel}:${c.start}-${c.end} · ${c.lines} ligne${c.lines > 1 ? 's' : ''}` : c.rel; }
  function renderChip() {
    ctxbar.hidden = !S.ctx;
    if (!S.ctx) return;
    chip.innerHTML = ICON.ctx; chip.append(h('span', null, chipText(S.ctx)));
    chip.classList.toggle('off', !S.ctxOn);
    chip.title = S.ctxOn ? 'Joint au message — clic pour ne pas l\'envoyer' : 'Non joint — clic pour le joindre';
  }

  // ── fenêtre « Serveurs MCP » (comme celle de Claude Code) ──
  const MCP_BADGE = {
    connecting: ['◐ Connexion…', 'b-wait'], connected: ['✓ Connecté', 'b-ok'], auth: ['⚠ Connexion requise', 'b-warn'], error: ['✗ Erreur', 'b-err'],
    disabled: ['○ Désactivé', 'b-off'], approve: ['? À autoriser', 'b-ask'], untrusted: ['? Projet à approuver', 'b-ask'], idle: ['◌ Non démarré', 'b-off'],
  };
  const MCP = { el: null, list: null, filter: null, data: null, open: new Set() };
  function mcpClose() { if (MCP.el) { MCP.el.remove(); MCP.el = null; ta.focus(); } }
  function mcpPanel(ov) {
    MCP.data = ov;
    if (!MCP.el) {
      const ov_ = h('div', 'modal-bg'); ov_.onclick = e => { if (e.target === ov_) mcpClose(); };
      const card = h('div', 'modal');
      const top = h('div', 'mh'); top.append(h('div', 'mt', 'Serveurs MCP'));
      const ref = h('button', 'icon-btn', '↻'); ref.title = 'Actualiser'; ref.onclick = () => post({ type: 'mcpAction', action: 'refresh' });
      const x = h('button', 'icon-btn', '✕'); x.title = 'Fermer (Échap)'; x.onclick = mcpClose;
      top.append(ref, x);
      const f = h('input', 'mf'); f.placeholder = 'Filtrer les serveurs…'; f.oninput = mcpRender;
      f.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); mcpClose(); } };
      const list = h('div', 'ml');
      card.append(top, f, list); ov_.append(card);
      document.body.append(ov_);
      MCP.el = ov_; MCP.list = list; MCP.filter = f;
      f.focus();
    }
    mcpRender();
  }
  function mcpStatus(r) {
    const s = MCP.data?.servers.find(x => x.name === r.name);
    if (!s) return;
    if (r.status !== 'error' && r.status !== 'auth') delete s.error;   // reconnecté : l'ancienne erreur disparaît (JSON ne transmet pas « error: undefined »)
    Object.assign(s, r);
    if (MCP.el) mcpRender();
  }
  function mcpRender() {
    if (!MCP.el || !MCP.data) return;
    const q = MCP.filter.value.trim().toLowerCase();
    const list = MCP.list; list.textContent = '';
    const servers = MCP.data.servers.filter(s => !q || s.name.toLowerCase().includes(q));
    const groups = [...new Set(servers.map(s => s.group))];
    for (const g of groups) {
      const items = servers.filter(s => s.group === g);
      list.append(h('div', 'mg', `${g === 'Claude Code' ? 'Claude Code' : g} (${items.length})`));
      for (const s of items) list.append(mcpRow(s));
    }
    const cloud = (MCP.data.cloud || []).filter(n => !q || n.toLowerCase().includes(q));
    if (cloud.length) {
      list.append(h('div', 'mg', `claude.ai (${cloud.length})`));
      list.append(h('div', 'mnote', 'Connecteurs de ton compte Claude : ils tournent chez Anthropic, pas sur ton PC. FS-CLI ne peut pas les utiliser.'));
      for (const n of cloud) {
        const row = h('div', 'mrow cloud');
        row.append(h('span', 'mn', n), h('span', 'badge b-off', 'Compte Claude'));
        list.append(row);
      }
    }
    if (!servers.length && !cloud.length) list.append(h('div', 'mnote', q ? 'Aucun serveur ne correspond.' : 'Aucun serveur MCP. Ajoute-en un avec /mcp add <nom> <commande|url> ou /mcp presets.'));
    if (MCP.data.error) list.append(h('div', 'mnote warn', '⚠ ' + MCP.data.error));
  }
  function mcpRow(s) {
    const wrap = h('div', 'mitem' + (MCP.open.has(s.name) ? ' open' : ''));
    const row = h('div', 'mrow');
    const [label, cls] = MCP_BADGE[s.status] || MCP_BADGE.idle;
    const badge = h('span', 'badge ' + cls, s.status === 'connected' && s.toolCount ? `✓ Connecté · ${s.toolCount}` : label);
    row.append(h('span', 'mn', s.name), badge);
    row.onclick = () => { if (MCP.open.has(s.name)) MCP.open.delete(s.name); else MCP.open.add(s.name); mcpRender(); };
    wrap.append(row);
    if (MCP.open.has(s.name)) {
      const d = h('div', 'mdet');
      d.append(h('div', 'mk', s.transport === 'http' ? 'URL' : 'Commande'), h('div', 'mv', s.target || '—'));
      if (s.source) d.append(h('div', 'mk', 'Source'), h('div', 'mv', s.source));
      if (s.description) d.append(h('div', 'mk', 'Rôle'), h('div', 'mv', s.description));
      if (s.error) d.append(h('div', 'mk', 'Erreur'), h('div', 'mv err', s.error));
      if (s.status === 'auth') d.append(h('div', 'mk', ''), h('div', 'mv', 'Ce serveur demande une connexion à ton compte. « Se connecter » ouvre sa page de connexion dans ton navigateur ; FS-CLI garde ensuite sa propre clé sur ton PC.'));
      if (s.loginUrl) { const a = h('a', null, 'la page de connexion ne s\'est pas ouverte ? clique ici'); a.onclick = e => { e.stopPropagation(); post({ type: 'openLink', url: s.loginUrl }); }; d.append(h('div', 'mk', ''), a); }
      if (s.tools?.length) {
        const tl = h('div', 'mtools');
        for (const t of s.tools) { const it = h('div', 'mtool'); it.append(h('span', 'mtn', t.name)); if (t.description) it.append(h('span', 'mtd', t.description)); tl.append(it); }
        d.append(h('div', 'mk', 'Outils'), tl);
      }
      const acts = h('div', 'macts');
      const btn = (label, action, sec) => { const b = h('button', 'btn' + (sec ? ' sec' : ''), label); b.onclick = e => { e.stopPropagation(); post({ type: 'mcpAction', action, name: s.name }); }; acts.append(b); };
      if (s.status === 'auth') btn('Se connecter', 'login');
      else if (s.status === 'approve') btn('Autoriser et connecter', 'approve');
      else if (s.status === 'untrusted') btn('Approuver les serveurs du projet', 'trust');
      else if (s.status !== 'disabled') btn(s.status === 'connected' ? 'Reconnecter' : 'Connecter', 'connect', s.status === 'connected');
      btn(s.status === 'disabled' ? 'Activer' : 'Désactiver', 'toggle', true);
      d.append(acts);
      wrap.append(d);
    }
    return wrap;
  }
  document.addEventListener('keydown', e => { if (MCP.el && e.key === 'Escape') { e.preventDefault(); mcpClose(); } });

  // ── carte d'infos (/usage…) : sections de lignes, barres de progression colorées selon le niveau ──
  function card(data) {
    const bg = h('div', 'modal-bg'); const close = () => { bg.remove(); document.removeEventListener('keydown', esc, true); ta.focus(); };
    const esc = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    bg.onclick = e => { if (e.target === bg) close(); };
    document.addEventListener('keydown', esc, true);
    const box = h('div', 'modal card-modal');
    const top = h('div', 'mh'); top.append(h('div', 'mt', data.title === 'Consommation' ? 'Compte & consommation' : (data.title || 'Infos')));
    const x = h('button', 'icon-btn', '✕'); x.title = 'Fermer (Échap)'; x.onclick = close; top.append(x);
    const el = h('div', 'card');
    box.append(top, el); bg.append(box);
    for (const sec of data.sections || []) {
      if (sec.title) el.append(h('div', 'cs', sec.title));
      for (const r of sec.rows || []) {
        const row = h('div', 'cr');
        row.append(h('div', 'cl', r.label));
        const v = h('div', 'cv' + (r.ok ? ' ok' : ''));
        if (typeof r.pct === 'number' && isFinite(r.pct)) {
          const p = Math.max(0, Math.min(100, r.pct));
          const top = h('div', 'bv'); top.append(h('b', null, `${Math.round(p)} %`), h('span', null, r.value || ''));
          const bar = h('div', 'bar' + (p > 90 ? ' crit' : p > 75 ? ' warn' : '')); const fill = h('i'); fill.style.width = p + '%'; bar.append(fill);
          v.append(top, bar);
        } else v.textContent = r.value || '';
        row.append(v);
        if (r.note) row.append(h('div', 'cn', r.note));
        el.append(row);
      }
    }
    if (data.footnote) el.append(h('div', 'cf', data.footnote));
    document.body.append(bg);
  }

  // ── sélecteur « Conversations » (horloge), comme celui de Claude Code : menu sous l'en-tête, onglets, recherche, titre + âge ──
  const HIST = { el: null, list: null, filter: null, data: null, timer: 0, tab: 'here' };
  function ago(t) {
    if (!t) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'maintenant';
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    return `${Math.floor(s / 86400)} j`;
  }
  function histClose() { if (HIST.el) { HIST.el.remove(); HIST.el = null; document.removeEventListener('mousedown', histOutside, true); ta.focus(); } }
  function histOutside(e) { if (HIST.el && !HIST.el.contains(e.target) && !btnHist.contains(e.target)) histClose(); }
  function histOpen() {
    if (HIST.el) return histClose();
    if (S.busy) return showFlash('attends la fin de la réponse');
    post({ type: 'historyOpen' });
    histShow({ sessions: null });                                       // ouvert tout de suite, la liste arrive (vérifiée sur le site)
    clearTimeout(HIST.timer);
    HIST.timer = setTimeout(() => { if (HIST.data === null) { histClose(); post({ type: 'command', text: '/resume' }); } }, 8000);   // ancien CLI : liste en texte
  }
  function histShow(ev) {
    if (ev.sessions) clearTimeout(HIST.timer);
    HIST.data = ev.sessions;
    if (!HIST.el) {
      const pop = h('div', 'pop');
      const tabs = h('div', 'ptabs');
      for (const [id, label] of [['here', 'Ce dossier'], ['all', 'Tous']]) {
        const b = h('button', 'ptab' + (HIST.tab === id ? ' on' : ''), label);
        b.onclick = () => { HIST.tab = id; tabs.querySelectorAll('.ptab').forEach(x => x.classList.toggle('on', x === b)); histRender(); };
        tabs.append(b);
      }
      const f = h('input', 'pf'); f.placeholder = 'Rechercher…'; f.oninput = histRender;
      f.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); histClose(); } if (e.key === 'Enter') HIST.list.querySelector('.prow')?.click(); };
      const list = h('div', 'plist');
      const nb = h('button', 'pnew', '＋ Nouvelle conversation'); nb.onclick = () => { histClose(); post({ type: 'command', text: '/new' }); };
      pop.append(tabs, f, list, nb);
      app.append(pop);
      HIST.el = pop; HIST.list = list; HIST.filter = f; f.focus();
      document.addEventListener('mousedown', histOutside, true);
    }
    histRender();
  }
  function histRender() {
    if (!HIST.el) return;
    const list = HIST.list; list.textContent = '';
    if (HIST.data === null) { list.append(h('div', 'pnote', 'Chargement…')); return; }
    const q = HIST.filter.value.trim().toLowerCase();
    let items = HIST.data.filter(s => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
    if (HIST.tab === 'here') items = items.filter(s => s.here);
    if (!items.length) { list.append(h('div', 'pnote', q ? 'Aucune conversation ne correspond.' : HIST.tab === 'here' ? 'Aucune conversation dans ce dossier (onglet « Tous » pour les autres).' : 'Aucune conversation enregistrée.')); return; }
    for (const s of items) {
      const row = h('div', 'prow' + (s.current ? ' cur' : ''));
      const dir = String(s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
      row.append(h('span', 'pt', s.title || '(sans titre)'), h('span', 'pa', ago(s.updatedAt)));
      row.title = [s.model, s.here ? '' : dir].filter(Boolean).join(' · ');
      row.onclick = () => { histClose(); if (!s.current) post({ type: 'resumeChat', chatId: s.chatId }); };
      list.append(row);
    }
  }
  document.addEventListener('keydown', e => { if (HIST.el && e.key === 'Escape') { e.preventDefault(); histClose(); } });

  /** conversation reprise : on réaffiche ses messages */
  function transcript(ev) {
    S.ai = null; S.tool = null; S.think = null;
    log.textContent = ''; welcome = null;
    if (ev.older) add(h('div', 'hold', `… ${ev.older} message${ev.older > 1 ? 's' : ''} plus ancien${ev.older > 1 ? 's' : ''}`));
    for (const m of ev.messages || []) {
      if (m.role === 'user') add(h('div', 'msg-user', m.text));
      else { const el = h('div', 'tl msg-ai'); el.innerHTML = md(m.text, false); add(el); }
    }
    const n = h('div', 'print'); n.textContent = `↺ conversation reprise · ${ev.title || ''} · ${ev.model || ''}`; add(n);
    stick = true; log.scrollTop = log.scrollHeight;
  }

  // ── fenêtre « Commandes & skills » (bouton « / »), comme « Slash commands » de Claude Code ──
  const SK = { el: null, list: null, filter: null, data: null, tab: 'skills' };
  const ktok = n => (n >= 1000 ? `≈ ${(n / 1000).toFixed(1).replace('.0', '').replace('.', ',')}k tokens` : `≈ ${n} tokens`);
  function skClose() { if (SK.el) { SK.el.remove(); SK.el = null; ta.focus(); } }
  function skOpen() {
    if (SK.el) return skClose();
    post({ type: 'skillsOpen' });
    skShow(null);
  }
  function skShow(data) {
    if (data) SK.data = data;
    if (!SK.el) {
      const bg = h('div', 'modal-bg'); bg.onclick = e => { if (e.target === bg) skClose(); };
      const card = h('div', 'modal');
      const top = h('div', 'mh'); top.append(h('div', 'mt', 'Commandes & skills'));
      const x = h('button', 'icon-btn', '✕'); x.title = 'Fermer (Échap)'; x.onclick = skClose; top.append(x);
      const tabs = h('div', 'ptabs sk-tabs');
      const f = h('input', 'mf'); f.placeholder = 'Filtrer…'; f.oninput = skRender;
      f.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); skClose(); } };
      const list = h('div', 'ml');
      card.append(top, tabs, f, list); bg.append(card); document.body.append(bg);
      SK.el = bg; SK.list = list; SK.filter = f; SK.tabs = tabs; f.focus();
    }
    skRender();
  }
  function skRender() {
    if (!SK.el) return;
    const d = SK.data;
    const tabsDef = [['skills', 'Skills du PC', d?.skills?.length], ['commands', 'Commandes', d?.commands?.length], ['fs', 'France Student', d?.fs?.length]];
    SK.tabs.textContent = '';
    for (const [id, label, n] of tabsDef) {
      const b = h('button', 'ptab' + (SK.tab === id ? ' on' : ''), n == null ? label : `${label} (${n})`);
      b.onclick = () => { SK.tab = id; skRender(); };
      SK.tabs.append(b);
    }
    const list = SK.list; list.textContent = '';
    if (!d) { list.append(h('div', 'mnote', 'Chargement…')); return; }
    const q = SK.filter.value.trim().toLowerCase();
    const items = (d[SK.tab] || []).filter(x => !q || x.name.toLowerCase().includes(q) || String(x.label || '').toLowerCase().includes(q) || String(x.description || '').toLowerCase().includes(q));
    if (SK.tab === 'skills') list.append(h('div', 'mnote', 'Choisis automatiquement selon ta demande, ou appelés avec /nom. Désactivé = jamais joint au modèle.'));
    if (SK.tab === 'commands' && !items.length && !q) list.append(h('div', 'mnote', 'Aucune commande perso. Crée un fichier ma-commande.md dans .fs-cli/commands/ (ou ~/.fs-cli/commands/) : il devient /ma-commande. Tes commandes de Claude Code (.claude/commands/) marchent aussi.'));
    if (SK.tab === 'fs') list.append(h('div', 'mnote', 'Compétences de France Student : celles activées sont jointes au début de chaque conversation.'));
    if (!items.length && q) list.append(h('div', 'mnote', 'Rien ne correspond.'));
    for (const it of items.slice(0, 300)) {
      const row = h('div', 'skrow');
      const main = h('div', 'skm');
      main.append(h('div', 'skn', SK.tab === 'fs' ? (it.label || it.name) : '/' + it.name));
      const meta = [it.source, it.tokens ? ktok(it.tokens) : ''].filter(Boolean).join(' · ');
      if (meta) main.append(h('div', 'skd', meta));
      if (it.description) main.title = it.description;
      if (SK.tab !== 'fs') main.onclick = () => { skClose(); ta.value = '/' + it.name + ' '; autosize(); ta.focus(); };
      else main.classList.add('noclick');
      row.append(main);
      if (SK.tab !== 'commands') {
        const t = h('button', 'sktog' + (it.enabled ? ' on' : ''), it.enabled ? 'On' : 'Off');
        t.title = it.enabled ? 'Désactiver' : 'Activer';
        t.onclick = () => post({ type: 'skillToggle', kind: SK.tab === 'fs' ? 'fs' : 'skill', name: it.name });
        row.append(t);
      }
      list.append(row);
    }
    if (items.length > 300) list.append(h('div', 'mnote', `… ${items.length - 300} de plus : affine avec le filtre`));
  }
  document.addEventListener('keydown', e => { if (SK.el && e.key === 'Escape') { e.preventDefault(); skClose(); } });

  // ── messages de l'extension ──
  window.addEventListener('message', ({ data: m }) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'context') { S.ctxOn = !!m.enabled; S.ctx = m.ctx || null; renderChip(); return; }
    if (m.type === 'insert') return insert(m.text);
    if (m.type === 'focusInput') { ta.focus(); return; }
    if (m.type === 'exit') {
      setBusy(false); S.started = false;
      if (m.needLogin) return notice('FS-CLI n\'est pas encore connecté à ton compte France Student.', 'error', [['Se connecter', () => post({ type: 'login' })], ['Relancer', () => post({ type: 'restart' }), true]]);
      return notice(`FS-CLI s'est arrêté${m.code != null && m.code !== 0 ? ` (code ${m.code})` : ''}.${m.message ? '\n' + m.message : ''}`, m.code ? 'error' : '', [['Relancer', () => post({ type: 'restart' })]]);
    }
    if (m.type !== 'event') return;
    const ev = m.ev;
    switch (ev.type) {
      case 'thinking': thinking(ev.delta || ''); break;
      case 'ready': S.shell = ev.shell || ''; S.models = ev.models || []; S.modes = ev.modes || []; S.commands = ev.commands || []; S.started = true; if (!log.querySelector('.msg-user, .msg-ai')) showWelcome(); break;
      case 'status': Object.assign(S.status, ev); renderStatus(); break;
      case 'busy': setBusy(!!ev.busy); break;
      case 'spinner': spinner(ev.label); break;
      case 'text': aiText(ev.delta || ''); break;
      case 'textEnd': aiEnd(); break;
      case 'tool': toolStart(ev); break;
      case 'toolLive': toolOut(ev.line, false, true); break;
      case 'toolOutput': toolOut(ev.text, ev.error, false); break;
      case 'toolDone': toolDone(ev.ok); break;
      case 'note': note(ev.text, ev.kind); break;
      case 'diff': diff(ev); break;
      case 'tasks': S.tasks = ev.list || []; renderTasks(); break;
      case 'changes': changes(ev.files || []); break;
      case 'fileUndone': {
        const row = [...log.querySelectorAll('.changes .f')].find(r => r.dataset.path === ev.path);
        if (row) row.classList.add('undone');
        showFlash('✓ ' + (ev.message || 'fichier restauré'));
        break;
      }
      case 'select': mcpClose(); selectCard(ev); break;
      case 'mcpPanel': mcpPanel(ev); break;
      case 'card': card(ev); break;
      case 'skills': skShow(ev); break;
      case 'history': histShow(ev); break;
      case 'transcript': transcript(ev); break;
      case 'mcpStatus': mcpStatus(ev); break;
      case 'mcpLoginUrl': mcpStatus({ name: ev.name, loginUrl: ev.url }); break;
      case 'ask': askCard(ev); break;
      case 'flash': showFlash(ev.text); break;
      case 'insert': insert(ev.text); break;
      case 'clear': S.ai = null; S.tool = null; S.think = null; showWelcome(); break;
      case 'print': {
        const text = String(ev.text || '');
        if (!text.replace(/\x1b\[[0-9;]*m/g, '').trim()) break;
        aiEnd();
        const p = h('div', 'print'); p.append(ansi(text.replace(/^\n+|\n+$/g, '').replace(/^ {2}/gm, ''))); add(p);
        break;
      }
    }
  });

  renderStatus(); showWelcome(); autosize();
  post({ type: 'ready' });
  ta.focus();
})();
