// Leitor do Gemini CLI: ~/.gemini/tmp/<projeto>/chats/session-*.jsonl
// Formato: a primeira linha é o cabeçalho da sessão; as seguintes trazem mudanças no estilo
// {"$set": {...}} (substitui campos, como a lista inteira de mensagens) ou uma mensagem solta.
// Cada mensagem tem type 'user' | 'gemini' | 'info' | 'error' e, nas respostas, toolCalls com status.
// Observação: montado a partir do formato do arquivo; ainda não testado com uma conversa real.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { clip, cleanPrompt } from './util.mjs';

const RECENT_MS = 45 * 60 * 1000;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n');
  return '';
}

// remonta a sessão a partir das linhas do arquivo
export function rebuildGeminiSession(lines) {
  const doc = { messages: [] };
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.$set && typeof o.$set === 'object') Object.assign(doc, o.$set);
    else if (o.$push && typeof o.$push === 'object') {
      for (const [k, v] of Object.entries(o.$push)) doc[k] = [...(doc[k] || []), ...(Array.isArray(v) ? v : [v])];
    } else if (o.type && o.id) {
      const i = doc.messages.findIndex((m) => m.id === o.id);
      if (i >= 0) doc.messages[i] = { ...doc.messages[i], ...o }; else doc.messages.push(o);
    } else if (o.sessionId) Object.assign(doc, o);
  }
  return doc;
}

// estado atual de uma sessão do Gemini CLI
export function geminiState(doc) {
  const msgs = (doc.messages || []).filter((m) => m.type === 'user' || m.type === 'gemini');
  const realUser = (m) => m.type === 'user' && !/^\s*<session_context>/.test(textOf(m.content));
  let lastUserIdx = -1;
  msgs.forEach((m, i) => { if (realUser(m)) lastUserIdx = i; });
  if (lastUserIdx < 0) return null;
  const prompt = cleanPrompt(textOf(msgs[lastUserIdx].content));
  const after = msgs.slice(lastUserIdx + 1).filter((m) => m.type === 'gemini');
  const last = after[after.length - 1];
  if (!last) return { state: 'thinking', prompt, reply: '', tool: '', promptCount: msgs.filter(realUser).length };
  const calls = last.toolCalls || [];
  const open = calls.find((c) => !/success|error|cancel|complete|done/i.test(String(c.status || '')));
  const tool = open?.displayName || open?.name || '';
  const reply = clip(textOf(last.content), 160);
  return { state: open ? 'tool' : 'done', prompt, reply, tool, promptCount: msgs.filter(realUser).length };
}

export function createGemini(core, { dir }) {
  const health = { found: false, watched: false, files: 0 };
  const seen = new Map(); // arquivo -> { promptCount, state }

  async function processFile(file, firstPass) {
    let stat;
    try { stat = await fsp.stat(file); } catch { return; }
    if (Date.now() - stat.mtimeMs > RECENT_MS && !seen.has(file)) return;
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch { return; }
    let doc = null;
    if (file.endsWith('.json')) { try { doc = JSON.parse(raw); } catch {} } // formato antigo: um JSON só
    doc ||= rebuildGeminiSession(raw.split('\n').filter((l) => l.trim()));
    const st = geminiState(doc);
    if (!st) return;
    const id = 'gm:' + (doc.sessionId || path.basename(file));
    const project = path.basename(path.dirname(path.dirname(file)));
    const base = { source: 'gemini', title: clip(st.prompt, 48) || 'Gemini CLI', project };
    const prev = seen.get(file);
    seen.set(file, { promptCount: st.promptCount, state: st.state });
    if (!prev) health.files++;

    if (!prev && firstPass) return void core.upsert(id, { ...base, state: st.state, lastPrompt: st.prompt, lastReply: st.reply, lastTool: st.tool });
    if (!prev || st.promptCount !== prev.promptCount) {
      core.upsert(id, { ...base, state: 'thinking', lastPrompt: st.prompt }, { type: 'prompt', text: st.prompt });
      if (st.state === 'tool') core.upsert(id, { ...base, state: 'tool', lastTool: st.tool }, { type: 'tool', text: st.tool, tool: st.tool });
      if (st.state === 'done') core.upsert(id, { ...base, state: 'done', lastReply: st.reply }, { type: 'done', text: st.reply });
      return;
    }
    if (st.state === 'tool' && (prev.state !== 'tool' || core.sessions.get(id)?.lastTool !== st.tool)) {
      core.upsert(id, { ...base, state: 'tool', lastTool: st.tool }, { type: 'tool', text: st.tool, tool: st.tool });
    } else if (st.state === 'done' && prev.state !== 'done') {
      core.upsert(id, { ...base, state: 'done', lastReply: st.reply }, { type: 'done', text: st.reply });
    }
  }

  async function scan(firstPass = false) {
    health.found = fs.existsSync(dir);
    if (!health.found) return;
    let projects;
    try { projects = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const chats = path.join(dir, p.name, 'chats');
      let files;
      try { files = await fsp.readdir(chats); } catch { continue; }
      for (const f of files) if (/^session-.*\.jsonl?$/.test(f)) await processFile(path.join(chats, f), firstPass);
    }
  }

  function watch() {
    if (!fs.existsSync(dir)) return false;
    try {
      fs.watch(dir, { recursive: true }, (_ev, name) => {
        if (!name || !/[\\/]chats[\\/]session-.*\.jsonl?$/.test(name)) return;
        processFile(path.join(dir, name), false).catch(() => {});
      });
      health.watched = true;
      return true;
    } catch { return false; }
  }

  return { scan, watch, health };
}
