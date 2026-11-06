// Funções pequenas usadas por vários módulos.
import crypto from 'node:crypto';

export function clip(s, n = 140) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// remove blocos internos (<system-reminder>, <command-...>, etc.) do texto do pedido
export function cleanPrompt(t) {
  t = String(t || '').replace(/<([a-z_-]+)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return clip(t, 160);
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function startOfDay(t = Date.now()) {
  const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime();
}
export function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// tira o prefixo de ferramentas MCP: mcp__servidor__acao -> acao
export const toolName = (n) => String(n || '').replace(/^mcp__.+?__/, '');

export const WORKING = new Set(['thinking', 'tool', 'waiting']);
