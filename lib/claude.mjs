// Leitor do Claude (Desktop, terminal, apps com Agent SDK): ~/.claude/projects/<projeto>/<sessão>.jsonl
// Só lê. O Windows avisa quando um arquivo muda (fs.watch) e uma varredura a cada 30 s cobre avisos perdidos.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { clip, cleanPrompt, startOfDay, toolName } from './util.mjs';

// ferramentas que param e esperam a pessoa responder
const ASK = { AskUserQuestion: 'tem uma pergunta pra você', ExitPlanMode: 'quer que você aprove o plano' };
// ferramentas rápidas: se ficarem sem resultado por alguns segundos, quase sempre é pedido de permissão
const FAST = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FAST_WAIT_MS = 5000;
const ASK_WAIT_MS = 1500;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const CHUNK = 4 * 1024 * 1024;

export function sourceFor(entrypoint) {
  if (entrypoint === 'claude-desktop') return 'desktop';
  if (entrypoint === 'cli') return 'terminal';
  if (entrypoint && entrypoint.startsWith('sdk')) return 'sdk';
  return 'terminal';
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  if (content.some((c) => c.type === 'tool_result')) return '';
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

export function createClaude(core, { dir, tempDir, hookInstalled }) {
  const fileState = new Map(); // caminho -> { offset, partial, sessionId, ignored, msgIds }
  // por sessão: ferramentas sem resultado ainda e subagentes rodando em segundo plano
  const aux = new Map();       // id -> { pending: Map<toolUseId, {...}>, bg: Map<toolUseId, {...}> }
  const health = { found: fs.existsSync(dir), watched: false, files: 0, lastLine: 0, error: '' };

  const auxOf = (id) => { if (!aux.has(id)) aux.set(id, { pending: new Map(), bg: new Map() }); return aux.get(id); };

  function helpersOf(id) {
    const x = auxOf(id);
    const out = [];
    for (const [k, p] of x.pending) if (AGENT_TOOLS.has(p.name)) out.push({ id: k, desc: clip(p.desc || 'subagente', 60), type: p.type || '' });
    for (const [k, b] of x.bg) if (!x.pending.has(k)) out.push({ id: k, desc: clip(b.desc || 'subagente', 60), type: b.type || '', bg: true });
    return out;
  }
  const sameHelpers = (a = [], b = []) => a.length === b.length && a.every((h, i) => h.id === b[i].id);

  function handleLine(file, line, replay) {
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const st = fileState.get(file);
    const id = 'cc:' + (o.sessionId || st.sessionId || path.basename(file, '.jsonl'));
    st.sessionId ||= o.sessionId;
    const at = Date.parse(o.timestamp) || Date.now();
    const opts = { at: replay ? at : Date.now(), silent: replay };
    health.lastLine = Date.now();

    if (o.type === 'custom-title' && o.customTitle) return core.upsert(id, { title: clip(o.customTitle, 48) }, null, opts);
    if (o.type === 'agent-name' && o.agentName && !core.sessions.get(id)?.title) return core.upsert(id, { title: clip(o.agentName, 48) }, null, opts);
    if (o.type !== 'user' && o.type !== 'assistant') return;
    if (o.isSidechain) return;

    const cwd = o.cwd || '';
    if (cwd && cwd.toLowerCase().startsWith(tempDir) && !cwd.toLowerCase().includes('scratchpad')) {
      st.ignored = true; // pings de saúde de SDK rodando na pasta Temp
      return;
    }
    const base = { source: sourceFor(o.entrypoint), project: cwd ? path.basename(cwd) : '' };
    const ev = (e) => (replay ? null : e);
    const x = auxOf(id);
    const cur = core.sessions.get(id);

    // qualquer linha nova depois de um "esperando você" vindo do hook quer dizer que a pessoa respondeu
    const resumed = cur?.state === 'waiting' && cur.waitingVia === 'hook' ? { state: 'tool', waitingFor: null, waitingVia: null } : null;

    if (o.type === 'user') {
      if (o.isMeta) return;
      const content = o.message?.content;
      if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) {
        let helpersChanged = false;
        for (const c of content) {
          if (c.type !== 'tool_result') continue;
          if (AGENT_TOOLS.has(x.pending.get(c.tool_use_id)?.name)) helpersChanged = true;
          x.pending.delete(c.tool_use_id);
        }
        const patch = { ...(resumed || {}) };
        if (cur?.state === 'waiting' && ![...x.pending.values()].some((p) => ASK[p.name])) Object.assign(patch, { state: 'tool', waitingFor: null, waitingVia: null });
        if (helpersChanged) patch.helpers = helpersOf(id);
        if (Object.keys(patch).length) core.upsert(id, { ...base, ...patch }, null, opts);
        return;
      }
      const raw = userText(content);
      if (!raw) return;
      x.pending.clear();
      if (/^\[Request interrupted/.test(raw)) {
        return core.upsert(id, { ...base, state: 'done', waitingFor: null, waitingVia: null, helpers: helpersOf(id) }, ev({ type: 'done', text: 'interrompido' }), opts);
      }
      const text = cleanPrompt(raw);
      if (!text) return;
      return core.upsert(id, { ...base, state: 'thinking', lastPrompt: text, lastTool: null, waitingFor: null, waitingVia: null, helpers: helpersOf(id) },
        replay ? { type: 'prompt', text, quiet: true } : { type: 'prompt', text }, opts);
    }

    // assistant
    const msg = o.message || {};
    if (msg.usage && msg.id && !st.msgIds.has(msg.id)) {
      st.msgIds.add(msg.id);
      if (!core.sessions.has(id)) core.upsert(id, base, null, { ...opts, silent: true });
      core.addTokens(id, msg.usage, opts.at, replay);
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const c of content) {
      if (c.type === 'tool_use') {
        const name = toolName(c.name);
        x.pending.set(c.id, { name, at: opts.at, desc: c.input?.description, type: c.input?.subagent_type });
        const patch = { ...base, state: 'tool', lastTool: name, waitingFor: null, waitingVia: null };
        if (AGENT_TOOLS.has(name)) patch.helpers = helpersOf(id);
        core.upsert(id, patch, replay ? { type: 'tool', tool: name, quiet: true } : { type: 'tool', text: name, tool: name }, opts);
      } else if (c.type === 'text' && c.text?.trim()) {
        core.upsert(id, { ...base, ...(resumed || {}), lastReply: clip(c.text, 160) }, null, opts);
      }
    }
    const stop = msg.stop_reason;
    if (stop === 'end_turn' || stop === 'stop_sequence') {
      x.pending.clear();
      const s = core.sessions.get(id);
      if (s?.state !== 'done') core.upsert(id, { ...base, state: 'done', waitingFor: null, waitingVia: null, helpers: helpersOf(id) }, ev({ type: 'done', text: s?.lastReply || '' }), opts);
    }
  }

  async function readNew(file, size, replay) {
    const st = fileState.get(file);
    if (size < st.offset) st.offset = 0; // arquivo truncado/reescrito
    if (size === st.offset) return;
    const fh = await fsp.open(file, 'r');
    try {
      while (st.offset < size) {
        const len = Math.min(CHUNK, size - st.offset);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.offset);
        st.offset += len;
        const lines = (st.partial + buf.toString('utf8')).split('\n');
        st.partial = lines.pop();
        for (const line of lines) if (line.trim()) handleLine(file, line, replay);
      }
    } finally {
      await fh.close();
    }
  }

  // subagentes em segundo plano: <projeto>/<sessão>/subagents/agent-*.meta.json
  async function readMeta(metaPath) {
    const parts = path.relative(dir, metaPath).split(/[\\/]/);
    if (parts.length !== 4 || parts[2] !== 'subagents') return;
    let m;
    try { m = JSON.parse(await fsp.readFile(metaPath, 'utf8')); } catch { return; }
    if (!m.toolUseId) return;
    const id = 'cc:' + parts[1];
    const x = auxOf(id);
    if (m.finished) x.bg.delete(m.toolUseId);
    else x.bg.set(m.toolUseId, { desc: m.description, type: m.agentType, at: Date.now() });
    const s = core.sessions.get(id);
    if (s && !sameHelpers(s.helpers, helpersOf(id))) core.upsert(id, { helpers: helpersOf(id) });
  }
  async function loadSubagents(file) {
    const sub = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
    let names;
    try { names = await fsp.readdir(sub); } catch { return; }
    for (const n of names) {
      if (!n.endsWith('.meta.json')) continue;
      try {
        const stt = await fsp.stat(path.join(sub, n));
        if (Date.now() - stt.mtimeMs < 2 * 60 * 60 * 1000) await readMeta(path.join(sub, n));
      } catch {}
    }
  }

  // processa um .jsonl: na primeira vez monta o estado sem animar; depois lê só o que entrou de novo
  const busy = new Set();
  async function processFile(file, firstPass) {
    if (busy.has(file)) { const st = fileState.get(file); if (st) st.again = true; return; }
    busy.add(file);
    try {
      let stat;
      try { stat = await fsp.stat(file); } catch { return; }
      if (!fileState.has(file)) {
        if (stat.mtimeMs < startOfDay()) return; // nada de hoje
        fileState.set(file, { offset: 0, partial: '', sessionId: null, msgIds: new Set() });
        health.files++;
        try { await readNew(file, stat.size, true); fileState.get(file).partial = ''; } catch {}
        const st0 = fileState.get(file);
        if (st0.ignored || !st0.sessionId) return;
        await loadSubagents(file);
        const s = core.sessions.get('cc:' + st0.sessionId);
        if (!s) return;
        // conversa que surgiu/voltou com o coletor já rodando: anima o pedido atual
        if (!firstPass && (s.state === 'thinking' || s.state === 'tool')) core.upsert(s.id, {}, { type: 'prompt', text: s.lastPrompt || '' });
        else core.publish(s.id);
        return;
      }
      const st = fileState.get(file);
      if (st.ignored) return;
      do { st.again = false; try { await readNew(file, (await fsp.stat(file)).size, false); } catch {} } while (st.again);
    } finally {
      busy.delete(file);
    }
  }

  async function scan(firstPass = false) {
    let dirs;
    try { dirs = await fsp.readdir(dir, { withFileTypes: true }); } catch { health.found = false; return; }
    health.found = true;
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const pdir = path.join(dir, d.name);
      let files;
      try { files = await fsp.readdir(pdir); } catch { continue; }
      for (const f of files) if (f.endsWith('.jsonl')) await processFile(path.join(pdir, f), firstPass);
    }
  }

  function watch() {
    try {
      fs.watch(dir, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const parts = name.split(/[\\/]/);
        if (parts.length === 2 && name.endsWith('.jsonl')) processFile(path.join(dir, name), false).catch(() => {});
        else if (parts.length === 4 && name.endsWith('.meta.json')) readMeta(path.join(dir, name)).catch(() => {});
      });
      health.watched = true;
      return true;
    } catch (e) {
      health.error = e.message;
      console.log('aviso de arquivos indisponível pro Claude, usando varredura:', e.message);
      return false;
    }
  }

  // a cada segundo: ferramenta parada há tempo demais = provavelmente esperando você
  function tick() {
    const now = Date.now();
    for (const [id, x] of aux) {
      for (const [k, b] of x.bg) if (now - b.at > 2 * 60 * 60 * 1000) x.bg.delete(k);
      if (!x.pending.size) continue;
      const s = core.sessions.get(id);
      if (!s || (s.state !== 'tool' && s.state !== 'thinking')) continue;
      let reason = '';
      for (const p of x.pending.values()) {
        if (ASK[p.name] && now - p.at > ASK_WAIT_MS) { reason = ASK[p.name]; break; }
        if (!hookInstalled() && FAST.has(p.name) && now - p.at > FAST_WAIT_MS) reason = `talvez esperando permissão (${p.name})`;
      }
      if (reason) core.upsert(id, { state: 'waiting', waitingFor: reason, waitingVia: 'heuristica' }, { type: 'waiting', text: reason });
    }
  }

  // aviso exato vindo do hook de notificação do Claude (hook.mjs)
  function onHook(p) {
    if (!p?.session_id) return false;
    const id = 'cc:' + p.session_id;
    const s = core.sessions.get(id);
    if (!s) return false;
    const msg = String(p.message || '');
    const type = String(p.notification_type || '');
    const needsYou = type === 'permission_prompt' || type === 'elicitation_dialog' || /permiss/i.test(msg)
      || p.hook_event_name === 'PermissionRequest';
    if (!needsYou) return false;
    const text = clip(msg || 'precisa da sua permissão', 120);
    core.upsert(id, { state: 'waiting', waitingFor: text, waitingVia: 'hook' }, { type: 'waiting', text });
    return true;
  }

  return { scan, watch, tick, onHook, health };
}
