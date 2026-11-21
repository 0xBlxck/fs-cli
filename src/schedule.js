// /plus-tard : heure d'envoi d'une demande programmée, et l'échéancier qui l'envoie.

/** « 5h », « 5h30 », « 05:00 », « 17h » → prochaine date à cette heure (aujourd'hui, sinon demain) ; null si ce n'est pas une heure */
export function parseHour(s, now = new Date()) {
  const m = /^(\d{1,2})(?:[h:](\d{2})?)$/i.exec(String(s || '').trim());
  if (!m || +m[1] > 23 || +(m[2] || 0) > 59) return null;
  const d = new Date(now); d.setHours(+m[1], +(m[2] || 0), 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Échéancier des demandes programmées. On compare l'HEURE RÉELLE (Date.now) à intervalles réguliers au lieu d'un seul
 * setTimeout : après une mise en veille ou un changement d'heure du PC, un minuteur unique part en retard ou trop tôt.
 * run(text) : envoie la demande ; isBusy() : une réponse est en cours → envoi au passage suivant (jamais deux à la fois) ;
 * onChange() : liste modifiée (barre du bas) ; onFire(item) : juste avant l'envoi.
 * → { add(at, text), cancel(id?) → items retirés, list(), next(), stop() }
 */
export function createScheduler({ run, isBusy = () => false, onChange = () => {}, onFire = () => {}, now = () => Date.now(), tickMs = 5000 } = {}) {
  const items = [];
  let seq = 0, timer = null, firing = false;
  const arm = () => {
    if (items.length && !timer) timer = setInterval(tick, tickMs);
    if (!items.length && timer) { clearInterval(timer); timer = null; }
  };
  async function tick() {
    if (firing || isBusy()) return;
    const due = items.filter(x => +x.at <= now()).sort((a, b) => a.at - b.at)[0];
    if (!due) return;
    items.splice(items.indexOf(due), 1);
    arm(); onChange();
    firing = true;
    try { onFire(due); await run(due.text); } catch {} finally { firing = false; }
  }
  return {
    add(at, text) {
      const item = { id: ++seq, at: new Date(at), text };
      items.push(item); arm(); onChange();
      if (+item.at <= now()) setTimeout(tick, 0);
      return item;
    },
    cancel(id = null) {
      const gone = items.filter(x => id == null || x.id === id);
      for (const g of gone) items.splice(items.indexOf(g), 1);
      arm(); if (gone.length) onChange();
      return gone;
    },
    list: () => [...items].sort((a, b) => a.at - b.at),
    next: () => [...items].sort((a, b) => a.at - b.at)[0] || null,
    tick,
    stop() { items.length = 0; arm(); },
  };
}
