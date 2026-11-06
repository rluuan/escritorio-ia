// Painéis da página: detalhe da sessão, resumo do dia + linha do tempo, configurações, saúde,
// avisos (na tela, som e notificação do Windows) e o feed de atividade.
// Não depende do three.js: a cena chama estas funções quando chegam mensagens.

const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const WORKING = new Set(['thinking', 'tool', 'waiting']);
const TL_WINDOW = 3 * 60 * 60 * 1000;

export function fmtDur(ms) {
  if (!ms || ms < 0) return '0 min';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`;
}
export function fmtNum(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
  if (n >= 1e3) return (n / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil';
  return String(n);
}
const hhmm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const STATE_TXT = { thinking: 'pensando', tool: 'usando ferramenta', waiting: 'esperando você', done: 'pronto', idle: 'parado' };

// ------------------------------------------------------------ preferências deste navegador
const PREF_KEY = 'escritorio.avisos';
const DEFAULT_PREFS = { waiting: true, done: true, sound: true, mineOnly: true };
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch {} }

export function createUI({ SRC, onFocusSession }) {
  const sessions = new Map();   // todas as sessões conhecidas (inclusive as que já saíram do escritório)
  const stats = new Map();      // owner -> estatísticas do dia
  let owners = [], me = '', local = false, health = null;
  let prefs = loadPrefs();
  let detailId = null;

  const srcColor = (s) => SRC[s]?.css || '#aaa';
  const srcName = (s) => SRC[s]?.name || s;

  // ---------------------------------------------------------- painéis: abrir/fechar
  const panels = ['detail', 'today', 'settings', 'healthBox'];
  function open(id) {
    for (const p of panels) if (p !== id && !(id === 'detail' && p === 'today')) $(p).classList.remove('open');
    $(id).classList.add('open');
  }
  function close(id) { $(id).classList.remove('open'); if (id === 'detail') detailId = null; }
  for (const p of panels) $(p).querySelector('[data-close]').addEventListener('click', () => close(p));
  addEventListener('keydown', (e) => { if (e.key === 'Escape') panels.forEach(close); });
  $('btnToday').addEventListener('click', () => { if ($('today').classList.contains('open')) close('today'); else { renderToday(); open('today'); } });
  $('btnSettings').addEventListener('click', () => { if ($('settings').classList.contains('open')) close('settings'); else { renderSettings(); open('settings'); } });
  $('status').addEventListener('click', () => { renderHealth(); open('healthBox'); });
  $('feedTitle').addEventListener('click', () => $('feed').classList.toggle('collapsed'));
  if (innerWidth < 720) $('feed').classList.add('collapsed');

  // ---------------------------------------------------------- detalhe da sessão
  function openDetail(id) {
    if (!sessions.has(id)) return;
    detailId = id;
    renderDetail();
    open('detail');
  }
  function renderDetail() {
    const s = sessions.get(detailId);
    if (!s) return;
    const now = Date.now();
    const working = WORKING.has(s.state);
    const pill = s.state === 'waiting' ? 'wait' : working ? 'work' : '';
    $('detailTitle').innerHTML = `<i class="dot" style="background:${srcColor(s.source)}"></i><span>${esc(s.title || s.project || srcName(s.source))}</span>`;
    const since = working && s.turnStart ? ` há ${fmtDur(now - s.turnStart)}` : s.updatedAt ? ` · ${hhmm(s.updatedAt)}` : '';
    const helpers = s.helpers || [];
    const spans = (s.spans || []).filter((sp) => sp[1] > now - TL_WINDOW);
    const turnMs = spans.reduce((a, sp) => a + (sp[1] - sp[0]), 0) + (working && s.turnStart ? now - s.turnStart : 0);
    $('detailBody').innerHTML = `
      <dl class="kv">
        <dt>Estado</dt><dd><span class="pill ${pill}">${esc(STATE_TXT[s.state] || s.state)}</span><span class="muted">${esc(since)}</span></dd>
        <dt>De</dt><dd>${esc(s.owner)} · ${esc(srcName(s.source))}</dd>
        ${s.project ? `<dt>Projeto</dt><dd>${esc(s.project)}</dd>` : ''}
        ${s.lastTool ? `<dt>Ferramenta</dt><dd><code>${esc(s.lastTool)}</code>${s.toolsTurn ? ` <span class="muted">(${s.toolsTurn} neste pedido)</span>` : ''}</dd>` : ''}
        ${s.tokens && (s.tokens.out || s.tokens.in) ? `<dt>Tokens</dt><dd>${fmtNum(s.tokens.out)} saída · ${fmtNum(s.tokens.in)} entrada · ${fmtNum(s.tokens.cache)} do cache</dd>` : ''}
        <dt>Trabalhando</dt><dd>${fmtDur(turnMs)} nas últimas 3 horas</dd>
      </dl>
      ${s.state === 'waiting' ? `<div class="box" style="border-color:var(--wait)"><span class="lbl" style="color:var(--wait)">precisa de você</span>${esc(s.waitingFor || '')}</div>` : ''}
      ${s.lastPrompt ? `<div class="box"><span class="lbl">último pedido</span>${esc(s.lastPrompt)}</div>` : ''}
      ${s.lastReply ? `<div class="box"><span class="lbl">última resposta</span>${esc(s.lastReply)}</div>` : ''}
      ${helpers.length ? `<div class="box"><span class="lbl">ajudantes (${helpers.length})</span><ul class="helpers">${helpers.map((h) =>
        `<li>🤖 ${esc(h.desc || 'subagente')}${h.type ? ` <span class="muted">· ${esc(h.type)}</span>` : ''}${h.bg ? ' <span class="muted">· em segundo plano</span>' : ''}</li>`).join('')}</ul></div>` : ''}`;
  }

  // ---------------------------------------------------------- hoje
  function bars(entries, color) {
    const max = Math.max(1, ...entries.map((e) => e[1]));
    return `<div class="bars">${entries.map(([k, v, c]) => `<div class="row"><span title="${esc(k)}">${esc(k)}</span><span class="bar"><i style="width:${(v / max) * 100}%;background:${c || color}"></i></span><b>${v}</b></div>`).join('')}</div>`;
  }
  function renderToday() {
    const order = [me, ...owners.map((o) => o.owner)].filter((o, i, a) => o && a.indexOf(o) === i);
    for (const o of stats.keys()) if (!order.includes(o)) order.push(o);
    $('todayCards').innerHTML = order.map((o) => {
      const st = stats.get(o);
      const prof = owners.find((x) => x.owner === o) || {};
      if (!st) return `<div class="card"><h4><i class="dot" style="background:${esc(prof.cor || '#a8998a')}"></i>${esc(o)}</h4><p class="muted">Sem dados ainda.</p></div>`;
      const tools = Object.entries(st.tools || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
      const toolsTotal = Object.values(st.tools || {}).reduce((a, b) => a + b, 0);
      const src = Object.entries(st.bySource || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [srcName(k), v, srcColor(k)]);
      return `<div class="card">
        <h4><i class="dot" style="background:${esc(prof.cor || '#a8998a')}"></i>${esc(o)}${o === me ? ' <span class="muted">(você)</span>' : ''}</h4>
        <div class="big">
          <div><b>${st.prompts}</b><small>pedidos</small></div>
          <div><b>${fmtDur(st.workMs)}</b><small>IA trabalhando</small></div>
          <div><b>${fmtNum(toolsTotal)}</b><small>ferramentas</small></div>
        </div>
        ${st.tokens && (st.tokens.out || st.tokens.in) ? `<p class="muted" style="margin:0 0 8px;font-size:11.5px">Tokens: ${fmtNum(st.tokens.out)} saída · ${fmtNum(st.tokens.in)} entrada · ${fmtNum(st.tokens.cache)} do cache</p>` : ''}
        ${src.length ? `<h5 style="margin-top:4px">Por ferramenta de IA</h5>${bars(src)}` : ''}
        ${tools.length ? `<h5>Ferramentas mais usadas</h5>${bars(tools, 'var(--accent)')}` : ''}
      </div>`;
    }).join('') || '<p class="muted">Sem dados ainda.</p>';
    renderTimeline();
  }

  function renderTimeline() {
    const now = Date.now(), from = now - TL_WINDOW;
    const rows = [...sessions.values()]
      .map((s) => {
        const spans = (s.spans || []).filter((sp) => sp[1] > from).map((sp) => [sp[0], sp[1], false]);
        if (WORKING.has(s.state) && s.turnStart && !s.removed) spans.push([s.turnStart, now, true]);
        return { s, spans };
      })
      .filter((r) => r.spans.length)
      .sort((a, b) => (a.s.owner === b.s.owner ? a.s.createdAt - b.s.createdAt : a.s.owner === me ? -1 : b.s.owner === me ? 1 : a.s.owner.localeCompare(b.s.owner)));
    const pct = (t) => ((Math.max(t, from) - from) / TL_WINDOW) * 100;
    const ticks = [];
    const first = Math.ceil(from / 1800000) * 1800000;
    for (let t = first; t <= now; t += 1800000) ticks.push(`<span style="left:${pct(t)}%">${hhmm(t)}</span>`);
    if (!rows.length) { $('timeline').innerHTML = '<p class="muted">Nenhuma IA trabalhou nas últimas 3 horas.</p>'; return; }
    $('timeline').innerHTML = `<div class="axis">${ticks.join('')}</div>` + rows.map(({ s, spans }) => {
      const color = srcColor(s.source);
      return `<div class="lane" data-id="${esc(s.id)}" style="cursor:pointer" title="${esc(s.owner)} · ${esc(srcName(s.source))}">
        <span class="name"><i class="dot" style="background:${color}"></i>${esc(s.title || s.project || srcName(s.source))}</span>
        <span class="track">${spans.map(([a, b, live]) => `<i class="${live ? 'open' : ''}" title="${hhmm(a)} a ${live ? 'agora' : hhmm(b)} (${fmtDur(b - a)})"
          style="left:${pct(a)}%;width:${Math.max(0.3, pct(b) - pct(a))}%;background:${live && s.state === 'waiting' ? 'var(--wait)' : color}"></i>`).join('')}
          <span class="now" style="left:100%"></span></span></div>`;
    }).join('');
    $('timeline').querySelectorAll('.lane').forEach((el) => el.addEventListener('click', () => { onFocusSession?.(el.dataset.id); openDetail(el.dataset.id); }));
  }

  // ---------------------------------------------------------- saúde
  function chip(label, ok, title) { return `<span class="h ${ok ? '' : 'off'}" title="${esc(title || '')}">${ok ? '✓' : '–'} ${esc(label)}</span>`; }
  function renderHealthChips() {
    if (!health) { $('healthChips').innerHTML = ''; return; }
    const peers = owners.filter((o) => !o.self);
    $('healthChips').innerHTML = chip('Claude', health.claude?.found) + chip('Antigravity', health.antigravity?.found && health.antigravity?.ok !== false)
      + (health.gemini?.files ? chip('Gemini', true) : '')
      + peers.map((p) => chip(p.owner, p.online, p.error || '')).join('');
  }
  function renderHealth() {
    const h = health || {};
    const line = (name, ok, txt) => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${ok ? '✅' : '⚪'} ${esc(name)}</span><span class="muted" style="text-align:right">${esc(txt)}</span></div>`;
    const ago = (t) => (t ? `${fmtDur(Date.now() - t)} atrás` : 'nunca');
    $('healthBody').innerHTML = !health ? '<p class="muted">Sem informação ainda.</p>' : [
      line('Claude', h.claude?.found, h.claude?.found ? `${h.claude.files} conversas hoje · ${h.claude.watched ? 'aviso do Windows' : 'varredura'} · última linha ${ago(h.claude.lastLine)}` : 'pasta ~/.claude não encontrada'),
      line('Antigravity', h.antigravity?.found && h.antigravity?.ok, h.antigravity?.found ? (h.antigravity.ok ? `lido ${ago(h.antigravity.lastScan)}` : `erro: ${h.antigravity.error}`) : 'não instalado'),
      line('Gemini CLI', h.gemini?.files > 0, h.gemini?.found ? `${h.gemini.files} conversas recentes` : 'não instalado'),
      line('Aviso exato do Claude (hook)', h.hook, h.hook ? 'instalado' : 'não instalado (usando estimativa)'),
      line('PIN da casa', h.pin, h.pin ? 'rede protegida' : 'sem PIN'),
      ...owners.filter((o) => !o.self).map((p) => line(`PC de ${p.owner}`, p.online, p.online ? 'conectado' : p.error || 'desconectado')),
      `<p class="muted" style="margin:10px 0 0;font-size:12px">Link na rede: <code>http://${esc(h.name)}:${esc(h.port)}</code></p>`,
    ].join('');
  }

  // ---------------------------------------------------------- configurações
  const sw = (id, on) => `<span class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></span>`;
  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-escritorio': '1' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `erro ${r.status}`);
    return j;
  }
  async function renderSettings() {
    const canNotify = 'Notification' in window && window.isSecureContext;
    const perm = canNotify ? Notification.permission : 'indisponível';
    let html = `
      <div class="section-title" style="margin-top:0">Avisos neste aparelho</div>
      <div class="field"><label class="row">Quando a IA precisar de mim ${sw('pWaiting', prefs.waiting)}</label></div>
      <div class="field"><label class="row">Quando terminar de responder ${sw('pDone', prefs.done)}</label></div>
      <div class="field"><label class="row">Tocar som ${sw('pSound', prefs.sound)}</label></div>
      <div class="field"><label class="row">Só das minhas sessões ${sw('pMine', prefs.mineOnly)}</label></div>
      <div class="field"><div class="row"><span>Notificação do Windows</span>${
        !canNotify ? '<span class="muted" style="font-size:12px">só abrindo pelo localhost</span>'
        : perm === 'granted' ? '<span class="pill work">ativada</span>'
        : perm === 'denied' ? '<span class="muted" style="font-size:12px">bloqueada no navegador</span>'
        : '<button class="btn" id="pPerm">Permitir</button>'}</div>
        <p>Aparece mesmo com o escritório minimizado. Sem ela, o aviso aparece só dentro da página.</p></div>`;
    if (local) html += '<div id="localSettings"><p class="muted">Carregando…</p></div>';
    else html += '<p class="muted" style="font-size:12px;margin-top:12px">PIN, visual e hook só podem ser mudados no próprio PC (abrindo pelo localhost).</p>';
    $('settingsBody').innerHTML = html;

    const bind = (id, key) => $(id).addEventListener('change', (e) => { prefs = { ...prefs, [key]: e.target.checked }; savePrefs(prefs); });
    bind('pWaiting', 'waiting'); bind('pDone', 'done'); bind('pSound', 'sound'); bind('pMine', 'mineOnly');
    $('pPerm')?.addEventListener('click', async () => { await Notification.requestPermission(); renderSettings(); });
    if (local) renderLocalSettings();
  }

  async function renderLocalSettings() {
    let c;
    try { c = await (await fetch('/api/config')).json(); } catch { $('localSettings').innerHTML = '<p class="msg err">Não consegui ler a configuração.</p>'; return; }
    const accNames = { nenhum: 'Nenhum', bone: 'Boné', oculos: 'Óculos', laco: 'Laço', fones: 'Fones', coroa: 'Coroa' };
    $('localSettings').innerHTML = `
      <div class="section-title">Seu visual (${esc(c.owner)})</div>
      <div class="field">
        <div class="row"><span>Cor</span><input type="color" id="cCor" value="${esc(c.cor || '#e07a52')}"></div>
        <div class="row"><span>Acessório dos bonecos</span><select id="cAcc">${c.accessories.map((a) => `<option value="${a}" ${a === c.acessorio ? 'selected' : ''}>${accNames[a] || a}</option>`).join('')}</select></div>
        <p>Aparece nos seus bonecos e na sua ala, nos dois PCs.</p><div class="msg" id="cMsg"></div>
      </div>
      <div class="section-title">Rede</div>
      <div class="field">
        <div class="row"><span>PIN da casa</span><span style="display:flex;gap:6px"><input type="password" inputmode="numeric" id="cPin" placeholder="${c.pin ? '••••' : 'sem PIN'}" style="width:110px"><button class="btn" id="cPinSave">Salvar</button>${c.pin ? '<button class="btn danger" id="cPinDel">Tirar</button>' : ''}</span></div>
        <p>Quem abrir o escritório por outro aparelho precisa digitar o PIN (de 4 a 8 números). Use <b>o mesmo PIN nos dois PCs</b>, senão eles não se conectam. Neste PC nunca é pedido.</p>
        <div class="msg" id="pinMsg"></div>
      </div>
      <div class="field"><label class="row">Mostrar o texto dos pedidos pra rede ${sw('cText', c.showText)}</label>
        <p>Desligado, quem vê pela rede só vê os bonecos e os estados, sem o que foi pedido.</p></div>
      <div class="section-title">Aviso exato do Claude</div>
      <div class="field">
        <div class="row"><span>Hook de notificação</span>${c.hook ? '<span class="pill work">instalado</span>' : '<span class="pill">não instalado</span>'}</div>
        <p>Sem o hook, o escritório estima quando o Claude está esperando você (pode errar). Com ele, o próprio Claude avisa quando pede permissão.
        Ele é adicionado em <code>~/.claude/settings.json</code> (uma cópia do arquivo fica em <code>settings.json.antes-escritorio-ia</code>) e roda só nesses momentos.
        Vale pras conversas abertas depois de instalar.</p>
        <div class="row"><code style="flex:1">${esc(c.hookCommand)}</code></div>
        <div><button class="btn ${c.hook ? 'danger' : 'primary'}" id="cHook">${c.hook ? 'Remover hook' : 'Instalar hook'}</button></div>
        <div class="msg" id="hookMsg"></div>
      </div>`;
    const msg = (id, txt, ok) => { const el = $(id); el.textContent = txt; el.className = 'msg ' + (ok ? 'ok' : 'err'); };
    const saveLook = async () => {
      try { await api('/api/config', { cor: $('cCor').value, acessorio: $('cAcc').value }); msg('cMsg', 'Salvo.', true); } catch (e) { msg('cMsg', e.message); }
    };
    $('cCor').addEventListener('change', saveLook);
    $('cAcc').addEventListener('change', saveLook);
    $('cPinSave').addEventListener('click', async () => {
      const pin = $('cPin').value.trim();
      if (!/^\d{4,8}$/.test(pin)) return msg('pinMsg', 'O PIN precisa ter de 4 a 8 números.');
      try { await api('/api/config', { pin }); renderLocalSettings(); } catch (e) { msg('pinMsg', e.message); }
    });
    $('cPinDel')?.addEventListener('click', async () => { try { await api('/api/config', { pin: '' }); renderLocalSettings(); } catch (e) { msg('pinMsg', e.message); } });
    $('cText').addEventListener('change', async (e) => { try { await api('/api/config', { showText: e.target.checked }); } catch {} });
    $('cHook').addEventListener('click', async () => {
      $('cHook').disabled = true;
      try { await api('/api/hook', { action: c.hook ? 'uninstall' : 'install' }); renderLocalSettings(); } catch (e) { msg('hookMsg', e.message); $('cHook').disabled = false; }
    });
  }

  // ---------------------------------------------------------- avisos
  let audio = null;
  addEventListener('pointerdown', () => { try { audio ||= new AudioContext(); audio.resume(); } catch {} }, { once: true });
  function beep(kind) {
    if (!prefs.sound || !audio) return;
    const notes = kind === 'waiting' ? [[660, 0], [880, 0.16], [660, 0.32]] : [[740, 0], [988, 0.12]];
    for (const [f, t] of notes) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, audio.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.18, audio.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 0.22);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.25);
    }
  }
  function toast(s, kind, title, text) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind === 'waiting' ? 'wait' : '');
    el.innerHTML = `<b>${esc(title)}</b>${esc(text)}`;
    el.addEventListener('click', () => { el.remove(); onFocusSession?.(s.id); openDetail(s.id); });
    $('toasts').prepend(el);
    while ($('toasts').children.length > 3) $('toasts').lastChild.remove();
    setTimeout(() => el.remove(), kind === 'waiting' ? 12000 : 6000);
  }
  function notify(s, ev) {
    if (ev.type !== 'waiting' && ev.type !== 'done') return;
    if (ev.type === 'waiting' && !prefs.waiting) return;
    if (ev.type === 'done' && (!prefs.done || ev.text === 'interrompido')) return;
    if (prefs.mineOnly && s.owner !== me) return;
    const name = s.title || s.project || srcName(s.source);
    const title = ev.type === 'waiting' ? `✋ ${name} precisa de você` : `✓ ${name} terminou`;
    const text = ev.type === 'waiting' ? (s.waitingFor || '') : (ev.text || s.lastReply || '');
    toast(s, ev.type, title, text);
    beep(ev.type);
    if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
      try {
        const n = new Notification(title, { body: `${srcName(s.source)} · ${text}`.slice(0, 180), tag: s.id, icon: 'icone.svg', requireInteraction: ev.type === 'waiting' });
        n.onclick = () => { focus(); onFocusSession?.(s.id); openDetail(s.id); n.close(); };
      } catch {}
    }
  }

  // ---------------------------------------------------------- feed
  function addFeed(s, ev) {
    if (ev.type === 'tool') return;
    $('feedList').querySelector('.empty')?.remove();
    const li = document.createElement('li');
    const verb = ev.type === 'prompt' ? 'pediu' : ev.type === 'waiting' ? 'precisa de você' : 'terminou';
    if (ev.type === 'waiting') li.className = 'wait';
    li.innerHTML = `<span class="who" style="color:${srcColor(s.source)}">${esc(s.owner)} · ${esc(srcName(s.source))}</span> <span class="verb">${verb}</span>` +
      (ev.type === 'prompt' && ev.text ? `: ${esc(ev.text.slice(0, 90))}` : '') +
      (ev.type === 'waiting' && s.waitingFor ? `: ${esc(s.waitingFor.slice(0, 90))}` : '') +
      `<span class="t">${hhmm(Date.now())}</span>`;
    li.style.cursor = 'pointer';
    li.addEventListener('click', () => { onFocusSession?.(s.id); openDetail(s.id); });
    $('feedList').prepend(li);
    while ($('feedList').children.length > 8) $('feedList').lastChild.remove();
  }

  // ---------------------------------------------------------- entrada de dados
  let todayTimer = 0;
  const refreshToday = () => {
    if (!$('today').classList.contains('open') || todayTimer) return;
    todayTimer = setTimeout(() => { todayTimer = 0; renderToday(); }, 800);
  };
  setInterval(() => {
    if (detailId && $('detail').classList.contains('open')) renderDetail();
    if ($('today').classList.contains('open')) renderTimeline();
  }, 5000);

  return {
    openDetail,
    get prefs() { return prefs; },
    setOwners(list, meName, isLocal) {
      owners = list; if (meName) me = meName; if (isLocal !== undefined) local = isLocal;
      renderHealthChips();
      if ($('healthBox').classList.contains('open')) renderHealth();
      refreshToday();
    },
    session(s, ev) {
      sessions.set(s.id, { ...s, removed: false });
      if (ev) { addFeed(s, ev); notify(s, ev); }
      if (detailId === s.id) renderDetail();
      refreshToday();
    },
    remove(id) { const s = sessions.get(id); if (s) s.removed = true; },
    stats(owner, st) { stats.set(owner, st); refreshToday(); },
    health(h) { health = h; renderHealthChips(); if ($('healthBox').classList.contains('open')) renderHealth(); },
  };
}
