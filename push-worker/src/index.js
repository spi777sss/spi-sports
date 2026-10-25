// SPI Sports · servidor de notificaciones.
// Cada minuto mira los marcadores de ESPN de los equipos que alguien sigue y, si pasa algo
// (inicio, gol, roja, descanso, final…), envía una notificación push a quien la pidió.
// Todo el estado vive en un único Durable Object para que no haya avisos duplicados.
import { DurableObject } from 'cloudflare:workers';
import { buildPushPayload } from '@block65/webcrypto-web-push';

const API = 'https://site.api.espn.com/apis/site/v2/sports/';
const APP_URL = 'https://spi777sss.github.io/spi-sports/';
const ORIGINS = ['https://spi777sss.github.io', 'http://localhost:8770', 'http://127.0.0.1:8770'];
const LEAGUES = {
  'esp.1': 'soccer', 'eng.1': 'soccer', 'ita.1': 'soccer', 'ger.1': 'soccer', 'fra.1': 'soccer',
  'uefa.champions': 'soccer', 'uefa.europa': 'soccer', 'por.1': 'soccer', 'ned.1': 'soccer',
  'mex.1': 'soccer', 'arg.1': 'soccer', 'bra.1': 'soccer', 'usa.1': 'soccer', 'nba': 'basketball',
};
const TYPES = {
  soccer: ['start', 'goal', 'red', 'ht', 'ft'],
  basketball: ['start', 'quarter', 'clutch', 'ft'],
};
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const MAX_TEAMS = 60;

const json = (data, status, origin) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...cors(origin) } });
function cors(origin) {
  return ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' } : {};
}
async function idFor(endpoint) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
  return [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// valida lo que manda la app: solo suscripciones push reales y preferencias conocidas
function cleanSubscription(s) {
  if (!s || typeof s.endpoint !== 'string' || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return null;
  let u; try { u = new URL(s.endpoint); } catch { return null; }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.test(u.hostname) || s.endpoint.length > 1024) return null;
  if (s.keys.p256dh.length > 200 || s.keys.auth.length > 100) return null;
  return { endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}
function cleanTeams(teams) {
  const out = {};
  if (!teams || typeof teams !== 'object') return out;
  for (const [k, t] of Object.entries(teams).slice(0, MAX_TEAMS)) {
    if (!t || typeof t !== 'object') continue;
    const sp = LEAGUES[t.lg];
    if (!sp || !/^(soccer|basketball):\d{1,8}$/.test(k) || !k.startsWith(sp + ':')) continue;
    const types = Array.isArray(t.types) ? t.types.filter(x => TYPES[sp].includes(x)) : [];
    if (!types.length) continue;
    out[k] = { lg: t.lg, name: String(t.name || '').slice(0, 60), types: [...new Set(types)] };
  }
  return out;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') return new Response('SPI Sports · notificaciones activas', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405, origin);
    if (!ORIGINS.includes(origin)) return json({ error: 'Origen no permitido' }, 403, origin);
    let body; try { body = await req.json(); } catch { return json({ error: 'JSON no válido' }, 400, origin); }
    const hub = env.HUB.get(env.HUB.idFromName('hub'));
    if (url.pathname === '/subscribe') {
      const sub = cleanSubscription(body.subscription);
      if (!sub) return json({ error: 'Suscripción no válida' }, 400, origin);
      const teams = cleanTeams(body.teams);
      return json(await hub.subscribe(sub, teams), 200, origin);
    }
    if (url.pathname === '/unsubscribe') {
      if (typeof body.endpoint !== 'string') return json({ error: 'Falta endpoint' }, 400, origin);
      return json(await hub.unsubscribe(body.endpoint), 200, origin);
    }
    if (url.pathname === '/test') {
      if (typeof body.endpoint !== 'string') return json({ error: 'Falta endpoint' }, 400, origin);
      return json(await hub.test(body.endpoint), 200, origin);
    }
    return json({ error: 'No encontrado' }, 404, origin);
  },
  async scheduled(_ev, env, ctx) {
    const hub = env.HUB.get(env.HUB.idFromName('hub'));
    ctx.waitUntil(hub.tick());
  },
};

export class Hub extends DurableObject {
  vapid() {
    return { subject: APP_URL, publicKey: this.env.VAPID_PUBLIC_KEY, privateKey: this.env.VAPID_PRIVATE_KEY };
  }
  async subs() { return (await this.ctx.storage.get('subs')) || {}; }

  async subscribe(sub, teams) {
    const subs = await this.subs();
    const id = await idFor(sub.endpoint);
    if (!Object.keys(teams).length) delete subs[id];
    else subs[id] = { sub, teams, updated: Date.now() };
    await this.ctx.storage.put('subs', subs);
    return { ok: true, teams: Object.keys(teams).length };
  }
  async unsubscribe(endpoint) {
    const subs = await this.subs();
    delete subs[await idFor(endpoint)];
    await this.ctx.storage.put('subs', subs);
    return { ok: true };
  }
  async test(endpoint) {
    const subs = await this.subs();
    const s = subs[await idFor(endpoint)];
    if (!s) return { ok: false, error: 'Este dispositivo no está suscrito' };
    const n = Object.keys(s.teams).length;
    const r = await this.send(s.sub, { title: 'SPI Sports', body: `Notificaciones activadas para ${n} equipo${n === 1 ? '' : 's'}. Así te llegarán los avisos.`, tag: 'spi-test', url: APP_URL });
    return { ok: r < 300, status: r };
  }

  async send(sub, note) {
    try {
      const payload = await buildPushPayload({ data: JSON.stringify(note), options: { ttl: 3600, urgency: 'high' } }, sub, this.vapid());
      const res = await fetch(sub.endpoint, payload);
      return res.status;
    } catch (e) { return 599; }
  }

  // se ejecuta cada minuto desde el cron
  async tick() {
    const subs = await this.subs();
    const ids = Object.keys(subs);
    if (!ids.length) return;
    const followed = new Set(), lgs = new Set();
    for (const id of ids) for (const [k, t] of Object.entries(subs[id].teams)) { followed.add(k); lgs.add(t.lg); }

    const state = (await this.ctx.storage.get('state')) || {};
    let dirty = false;
    const notes = [];
    const boards = await Promise.all([...lgs].map(lg => fetch(`${API}${LEAGUES[lg]}/${lg}/scoreboard`, { cf: { cacheTtl: 20 } }).then(r => r.ok ? r.json() : null).catch(() => null).then(d => [lg, d])));
    for (const [lg, d] of boards) {
      if (!d) continue;
      const sp = LEAGUES[lg];
      for (const e of d.events || []) {
        const c = e.competitions?.[0]; if (!c) continue;
        const H = c.competitors?.find(x => x.homeAway === 'home'), A = c.competitors?.find(x => x.homeAway === 'away');
        if (!H || !A) continue;
        const hk = sp + ':' + H.team.id, ak = sp + ':' + A.team.id;
        if (!followed.has(hk) && !followed.has(ak)) continue;
        const cur = snapshot(c, sp, H, A);
        const prev = state[e.id];
        if (!prev) { state[e.id] = cur; dirty = true; continue; } // primera vez: solo se registra, sin avisar
        const evs = diff(prev, cur, c, sp, H, A);
        if (evs.length || JSON.stringify(stripT(prev)) !== JSON.stringify(stripT(cur))) { state[e.id] = { ...cur, clutch: prev.clutch || cur.clutch }; dirty = true; }
        for (const ev of evs) notes.push({ ...ev, teams: [hk, ak], tag: 'spi-' + e.id + '-' + ev.type + '-' + (ev.n || ''), url: `${APP_URL}?m=${encodeURIComponent(lg + '|' + e.id)}` });
      }
    }
    // limpia partidos de hace más de 3 días
    const old = Date.now() - 3 * 864e5;
    for (const k of Object.keys(state)) if (state[k].t < old) { delete state[k]; dirty = true; }
    if (dirty) await this.ctx.storage.put('state', state);
    if (!notes.length) return;

    let gone = false;
    await Promise.all(ids.map(async id => {
      const s = subs[id];
      for (const n of notes) {
        const want = n.teams.some(k => s.teams[k]?.types.includes(n.type));
        if (!want) continue;
        const st = await this.send(s.sub, { title: n.title, body: n.body, tag: n.tag, url: n.url });
        if (st === 404 || st === 410) { delete subs[id]; gone = true; break; }
      }
    }));
    if (gone) await this.ctx.storage.put('subs', subs);
  }
}

const stripT = s => { const { t, ...rest } = s; return rest; };
function clockSecs(c) { const s = c.status?.displayClock || ''; const m = s.match(/(\d+):(\d+)/); return m ? +m[1] * 60 + +m[2] : (parseFloat(s) || 0); }
function snapshot(c, sp, H, A) {
  const t = c.status?.type || {};
  const st = t.name === 'STATUS_HALFTIME' ? 'ht' : t.state === 'in' ? 'in' : t.state === 'post' ? 'post' : 'pre';
  const det = c.details || [];
  const o = { s: st, h: +H.score || 0, a: +A.score || 0, t: Date.now() };
  if (sp === 'soccer') o.r = [det.filter(x => x.redCard && x.team?.id === H.team.id).length, det.filter(x => x.redCard && x.team?.id === A.team.id).length];
  else {
    o.p = c.status?.period || 0;
    o.end = t.name === 'STATUS_END_PERIOD' || t.name === 'STATUS_HALFTIME' ? o.p : 0;
    o.clutch = st === 'in' && o.p >= 4 && clockSecs(c) <= 120 && Math.abs(o.h - o.a) <= 5;
  }
  return o;
}
const ord = n => ({ 1: '1.er', 2: '2.º', 3: '3.er', 4: '4.º' }[n] || n + '.º');
function diff(p, c, comp, sp, H, A) {
  const hn = H.team.shortDisplayName || H.team.displayName, an = A.team.shortDisplayName || A.team.displayName;
  const score = `${hn} ${c.h}-${c.a} ${an}`;
  const out = [];
  const startedNow = (p.s === 'pre') && (c.s === 'in' || c.s === 'ht');
  if (startedNow) out.push({ type: 'start', title: '▶️ Empieza el partido', body: `${hn} vs ${an}` });
  if (sp === 'soccer') {
    const goals = (comp.details || []).filter(x => x.scoringPlay);
    for (const [side, team, name] of [['h', H, hn], ['a', A, an]]) {
      const was = p[side], now = c[side];
      if (now > was) {
        const mine = goals.filter(x => x.team?.id === team.team.id);
        for (let i = was; i < now; i++) {
          const g = mine[i];
          const who = g?.athletesInvolved?.[0]?.displayName;
          const min = g?.clock?.displayValue || '';
          const kind = g?.ownGoal ? ' (en propia)' : g?.penaltyKick ? ' (penalti)' : '';
          out.push({ type: 'goal', n: side + (i + 1), title: `⚽ ¡Gol de ${name}!`, body: `${who ? who + kind + ' ' + min + ' · ' : ''}${score}` });
        }
      } else if (now < was) out.push({ type: 'goal', n: side + 'x' + now, title: '🚫 Gol anulado', body: score });
    }
    const reds = (comp.details || []).filter(x => x.redCard);
    for (const [i, team, name] of [[0, H, hn], [1, A, an]]) {
      if ((c.r?.[i] || 0) > (p.r?.[i] || 0)) {
        const mine = reds.filter(x => x.team?.id === team.team.id);
        const last = mine[mine.length - 1];
        out.push({ type: 'red', n: i + '-' + c.r[i], title: `🟥 Roja para ${name}`, body: `${last?.athletesInvolved?.[0]?.displayName || 'Expulsión'} ${last?.clock?.displayValue || ''} · ${score}` });
      }
    }
    if (c.s === 'ht' && p.s !== 'ht') out.push({ type: 'ht', title: '⏸️ Descanso', body: score });
  } else {
    if (c.end && c.end !== p.end && c.s !== 'post') out.push({ type: 'quarter', n: c.end, title: `🏀 Fin del ${ord(c.end)} cuarto`, body: score });
    if (c.clutch && !p.clutch) out.push({ type: 'clutch', title: '🔥 Final ajustado', body: `Quedan menos de 2 minutos · ${score}` });
  }
  if (c.s === 'post' && p.s !== 'post') {
    const w = c.h > c.a ? hn : c.a > c.h ? an : null;
    out.push({ type: 'ft', title: w ? `🏁 Final: gana ${w}` : '🏁 Final: empate', body: score });
  }
  return out;
}
