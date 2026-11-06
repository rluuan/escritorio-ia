// Instala/remove o hook de notificação do Claude em ~/.claude/settings.json.
// Só roda quando a pessoa clica no botão da página (no próprio PC). Antes de mudar, guarda uma cópia.
// O hook chama hook.mjs, que só repassa o aviso pro coletor e sai.
import fs from 'node:fs';
import path from 'node:path';

const MARK = 'escritorio-ia';

export function createHookConfig({ settingsPath, appDir, nodePath }) {
  const script = path.join(appDir, 'hook.mjs').replace(/\\/g, '/');
  const command = `"${nodePath.replace(/\\/g, '/')}" "${script}"`;
  let cache = { at: 0, installed: false };

  function readSettings() {
    if (!fs.existsSync(settingsPath)) return {};
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, ''));
  }
  const ours = (h) => typeof h?.command === 'string' && h.command.includes(MARK) && h.command.includes('hook.mjs');

  function installed() {
    if (Date.now() - cache.at < 5000) return cache.installed;
    let ok = false;
    try { ok = (readSettings().hooks?.Notification || []).some((g) => (g.hooks || []).some(ours)); } catch {}
    cache = { at: Date.now(), installed: ok };
    return ok;
  }

  function write(settings) {
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + '.antes-escritorio-ia');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    cache.at = 0;
  }

  function install() {
    const s = readSettings(); // se o arquivo estiver quebrado, dá erro e não mexe em nada
    s.hooks ||= {};
    const list = (s.hooks.Notification || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
    list.push({ matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] });
    s.hooks.Notification = list;
    write(s);
  }

  function uninstall() {
    const s = readSettings();
    if (!s.hooks?.Notification) return;
    const list = s.hooks.Notification.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
    if (list.length) s.hooks.Notification = list; else delete s.hooks.Notification;
    if (!Object.keys(s.hooks).length) delete s.hooks;
    write(s);
  }

  return { installed, install, uninstall, command };
}
