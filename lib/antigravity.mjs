// Leitor do Antigravity: ~/.gemini/antigravity/conversation_summaries.db (SQLite, só leitura)
// e conversations/<id>.db pro texto do pedido.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clip } from './util.mjs';

const RECENT_MS = 45 * 60 * 1000;

// O passo do usuário é protobuf. Assinatura observada: um id de 32 hex e, logo depois,
// o texto da mensagem gravado duas vezes (cada cópia com o seu prefixo de tamanho).
export function extractUserText(buf) {
  const s = buf.toString('utf8');
  const m = /[0-9a-f]{32}/.exec(s);
  if (m) {
    const rest = s.slice(m.index + 32);
    // pula a tag e o tamanho (bytes de controle) até o começo do texto
    for (let skip = 0; skip < 6 && skip < rest.length; skip++) {
      const maxLen = Math.min(8000, Math.floor((rest.length - skip) / 2));
      for (let len = maxLen; len >= 1; len--) {
        // texto válido = a segunda cópia começa até 8 bytes depois do fim da primeira
        for (let gap = 1; gap <= 8; gap++) {
          if (rest.charCodeAt(skip) !== rest.charCodeAt(skip + len + gap)) continue;
          if (rest.startsWith(rest.slice(skip, skip + len), skip + len + gap)) {
            let cand = rest.slice(skip, skip + len);
            // o byte de tamanho (32..126) parece uma letra: tira se ele for o tamanho do resto
            if (cand.length > 1 && cand.charCodeAt(0) === Buffer.byteLength(cand.slice(1))) cand = cand.slice(1);
            if (cand.trim() && !/[\x00-\x08\x0e-\x1f�]/.test(cand)) return cand.trim();
          }
        }
      }
    }
  }
  // plano B: primeiro trecho legível depois do id
  const parts = s.split(/[\x00-\x08\x0e-\x1f�]+/).map((p) => p.trim()).filter(Boolean);
  const i = parts.findIndex((p) => /^[0-9a-f]{32}$/.test(p));
  return i >= 0 && parts[i + 1] ? parts[i + 1].replace(/"$/, '') : '';
}

export function createAntigravity(core, { dir }) {
  const seen = new Map(); // conversation_id -> { running, inputIdx, steps }
  let ready = false;      // depois da primeira varredura, conversa nunca vista = pedido novo
  const health = { found: false, watched: false, ok: false, error: '', lastScan: 0 };

  function promptText(convId, idx) {
    const dbPath = path.join(dir, 'conversations', `${convId}.db`);
    if (!fs.existsSync(dbPath)) return '';
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare('select step_payload from steps where idx = ?').get(idx);
      if (!row?.step_payload) return '';
      return clip(extractUserText(Buffer.from(row.step_payload)), 160);
    } catch {
      return '';
    } finally {
      try { db?.close(); } catch {}
    }
  }

  function scan() {
    const dbPath = path.join(dir, 'conversation_summaries.db');
    health.found = fs.existsSync(dbPath);
    if (!health.found) return;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const since = new Date(Date.now() - RECENT_MS).toISOString().replace('T', ' ').slice(0, 19);
      const rows = db.prepare(`
        select conversation_id, preview, title, status, step_count, workspace_uris, parent_conversation_id,
               last_user_input_step_index, not_fully_idle, last_modified_time, nesting_depth
        from conversation_summaries
        where last_modified_time >= ? and killed = 0
      `).all(since);

      // conversas-filhas rodando = ajudantes da conversa principal
      const helpers = new Map();
      for (const r of rows) {
        if (!r.nesting_depth || !r.parent_conversation_id) continue;
        const running = r.status !== 'CASCADE_RUN_STATUS_IDLE' || !!r.not_fully_idle;
        if (!running) continue;
        const list = helpers.get(r.parent_conversation_id) || [];
        list.push({ id: r.conversation_id, desc: clip(r.title || r.preview || 'subagente', 60), type: '' });
        helpers.set(r.parent_conversation_id, list);
      }

      for (const r of rows) {
        if (r.nesting_depth) continue;
        const id = 'ag:' + r.conversation_id;
        const prev = seen.get(r.conversation_id);
        const waiting = /WAIT/i.test(r.status || '');
        const running = !waiting && (r.status !== 'CASCADE_RUN_STATUS_IDLE' || !!r.not_fully_idle);
        let project = '';
        try { project = path.basename(decodeURIComponent(JSON.parse(r.workspace_uris)[0] || '')); } catch {}
        const hl = helpers.get(r.conversation_id) || [];
        const base = { source: 'antigravity', title: clip(r.title || r.preview || 'Antigravity', 48), project, helpers: hl };
        const cur = { running, waiting, inputIdx: r.last_user_input_step_index, steps: r.step_count, helperKey: hl.map((h) => h.id).join() };
        seen.set(r.conversation_id, cur);

        if (!prev) {
          const lastPrompt = promptText(r.conversation_id, r.last_user_input_step_index);
          if (ready) {
            // conversa nova aberta com o coletor já rodando: é um pedido
            core.upsert(id, { ...base, state: running ? 'thinking' : 'done', lastPrompt }, { type: 'prompt', text: lastPrompt });
            if (!running) core.upsert(id, { ...base, state: 'done' }, { type: 'done', text: '' });
          } else {
            core.upsert(id, { ...base, state: waiting ? 'waiting' : running ? 'tool' : 'done', lastPrompt }); // estado inicial, sem animar
          }
          continue;
        }
        if (cur.inputIdx !== prev.inputIdx && cur.inputIdx >= 0) {
          const text = promptText(r.conversation_id, cur.inputIdx);
          core.upsert(id, { ...base, state: 'thinking', lastPrompt: text, waitingFor: null }, { type: 'prompt', text });
          if (!running && !waiting) core.upsert(id, { ...base, state: 'done' }, { type: 'done', text: '' }); // respondeu entre duas leituras
        } else if (waiting && !prev.waiting) {
          core.upsert(id, { ...base, state: 'waiting', waitingFor: 'esperando você', waitingVia: 'antigravity' }, { type: 'waiting', text: 'esperando você' });
        } else if (running && (cur.steps !== prev.steps || prev.waiting)) {
          core.upsert(id, { ...base, state: 'tool', lastTool: 'trabalhando', waitingFor: null }, { type: 'tool', text: `passo ${cur.steps}` });
        } else if (cur.helperKey !== prev.helperKey) {
          core.upsert(id, { helpers: hl });
        }
        if ((prev.running || prev.waiting) && !running && !waiting && cur.inputIdx === prev.inputIdx) {
          core.upsert(id, { ...base, state: 'done', waitingFor: null }, { type: 'done', text: '' });
        }
      }
      ready = true;
      health.ok = true; health.error = ''; health.lastScan = Date.now();
    } catch (e) {
      health.ok = false; health.error = e.message; // banco ocupado: tenta no próximo ciclo
    } finally {
      try { db?.close(); } catch {}
    }
  }

  // o banco muda (arquivo -wal) a cada passo; consulta só quando o Windows avisa
  let timer = null;
  const soon = () => { if (!timer) timer = setTimeout(() => { timer = null; scan(); }, 250); };
  function watch() {
    if (!fs.existsSync(dir)) return false;
    try {
      fs.watch(dir, (_ev, name) => { if (name && name.startsWith('conversation_summaries')) soon(); });
      const conv = path.join(dir, 'conversations');
      if (fs.existsSync(conv)) fs.watch(conv, () => soon());
      health.watched = true;
      return true;
    } catch (e) {
      console.log('aviso de arquivos indisponível pro Antigravity, usando varredura:', e.message);
      return false;
    }
  }

  return { scan, watch, health };
}
