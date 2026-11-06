// Núcleo: guarda as sessões desta máquina, transmite as mudanças e soma as estatísticas do dia.
// Todos os leitores (Claude, Antigravity, Gemini) passam por upsert(), então o tempo de trabalho,
// a linha do tempo e os contadores funcionam igual pra qualquer ferramenta.
import { WORKING, dayKey, startOfDay } from './util.mjs';

export const EXPIRE_MS = 45 * 60 * 1000;   // sessão parada há mais que isso sai do escritório
const SPAN_KEEP_MS = 3 * 60 * 60 * 1000;   // a linha do tempo mostra as últimas 3 horas

export function createCore({ owner, showText }) {
  /** @type {Map<string, any>} todas as sessões de hoje desta máquina (visíveis ou não) */
  const sessions = new Map();
  const clients = new Set();      // navegadores (veem tudo)
  const peerClients = new Set();  // outros coletores (veem só o local)

  const emptyStats = () => ({ date: dayKey(), prompts: 0, workMs: 0, tools: {}, bySource: {},
    tokens: { in: 0, out: 0, cache: 0 } });
  let stats = emptyStats();
  let statsDirty = true;

  function write(set, obj) {
    const data = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of set) res.write(data);
  }
  function forNetwork(obj) {
    if (showText() || obj.kind !== 'session') return obj;
    const { lastPrompt, lastReply, ...session } = obj.session;
    session.helpers = (session.helpers || []).map((h) => ({ ...h, desc: '' }));
    return { ...obj, session, event: obj.event && { ...obj.event, text: '' } };
  }
  function send(obj) {
    write(clients, obj);
    write(peerClients, forNetwork(obj));
  }

  const visible = (s, now = Date.now()) => now - s.updatedAt <= EXPIRE_MS;

  function rollDay() {
    if (stats.date !== dayKey()) { stats = emptyStats(); statsDirty = true; }
  }
  function countToday(at, fn) {
    rollDay();
    if (at >= startOfDay()) { fn(stats); statsDirty = true; }
  }

  /**
   * Atualiza uma sessão. `at` é o momento real do acontecimento (no histórico, o horário da linha).
   * `silent` monta o estado sem transmitir (leitura do histórico na largada).
   */
  function upsert(id, patch, event, { at = Date.now(), silent = false } = {}) {
    const prev = sessions.get(id) || { id, owner, state: 'idle', createdAt: at, spans: [], tokens: { in: 0, out: 0, cache: 0 }, helpers: [] };
    const next = { ...prev, ...patch, updatedAt: Math.max(prev.updatedAt || 0, at) };

    // começo e fim de um turno (pedido -> resposta pronta)
    const wasWorking = WORKING.has(prev.state), isWorking = WORKING.has(next.state);
    if (!wasWorking && isWorking) { next.turnStart = at; next.toolsTurn = 0; }
    if (event?.type === 'prompt') {
      next.turnStart = at; next.toolsTurn = 0;
      countToday(at, (st) => { st.prompts++; st.bySource[next.source] = (st.bySource[next.source] || 0) + 1; });
    }
    if (event?.type === 'tool' && event.tool) {
      next.toolsTurn = (next.toolsTurn || 0) + 1;
      countToday(at, (st) => { st.tools[event.tool] = (st.tools[event.tool] || 0) + 1; });
    }
    if (wasWorking && !isWorking && prev.turnStart) {
      const start = prev.turnStart;
      countToday(at, (st) => { st.workMs += Math.max(0, at - Math.max(start, startOfDay())); });
      next.spans = [...(prev.spans || []), [start, at]].filter((sp) => sp[1] > Date.now() - SPAN_KEEP_MS).slice(-40);
      next.turnStart = null;
    }

    next.hidden = false;
    sessions.set(id, next);
    if (!silent && visible(next)) send({ kind: 'session', session: next, event: event || null });
    return next;
  }

  function addTokens(id, usage, at, silent) {
    const s = sessions.get(id);
    if (!s || !usage) return;
    const add = { in: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      out: usage.output_tokens || 0, cache: usage.cache_read_input_tokens || 0 };
    s.tokens = { in: s.tokens.in + add.in, out: s.tokens.out + add.out, cache: s.tokens.cache + add.cache };
    countToday(at, (st) => { st.tokens.in += add.in; st.tokens.out += add.out; st.tokens.cache += add.cache; });
    if (!silent && visible(s)) send({ kind: 'session', session: s, event: null });
  }

  // manda de novo uma sessão montada em silêncio
  function publish(id) {
    const s = sessions.get(id);
    if (s && visible(s)) send({ kind: 'session', session: s, event: null });
  }

  function snapshot() {
    const now = Date.now();
    return [...sessions.values()].filter((s) => visible(s, now));
  }

  // sessões paradas saem do escritório (e voltam se mexerem de novo); à meia-noite, limpa o resto
  function expire() {
    const now = Date.now();
    rollDay();
    for (const [id, s] of sessions) {
      if (!visible(s, now) && !s.hidden) { s.hidden = true; send({ kind: 'remove', id }); }
      if (s.hidden && s.updatedAt < startOfDay()) sessions.delete(id);
    }
  }

  function statsMessage() { rollDay(); return { kind: 'stats', owner, stats }; }
  function flushStats() {
    if (!statsDirty) return;
    statsDirty = false;
    send(statsMessage());
  }

  return { sessions, clients, peerClients, write, send, forNetwork, upsert, addTokens, publish, snapshot, expire,
    statsMessage, flushStats, get stats() { return stats; } };
}
