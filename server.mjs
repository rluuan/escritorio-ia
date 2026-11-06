// Escritório IA: coletor local.
// Observa as sessões do Claude (Desktop, terminal, Agent SDK), do Antigravity e do Gemini CLI
// e transmite o estado de cada uma pra cena 3D via Server-Sent Events.
// Só lê as pastas das ferramentas. As únicas coisas que ele grava são o próprio config.json,
// o próprio registro, os próprios arquivos ao se atualizar e, se você pedir pelo botão, o hook do Claude.
//
// Módulos (pasta lib/):
//   nucleo       sessões, estatísticas do dia e linha do tempo
//   claude       leitor do Claude (+ "esperando você" e subagentes)
//   antigravity  leitor do Antigravity
//   gemini       leitor do Gemini CLI
//   rede         outros PCs (descoberta e troca de sessões)
//   mdns         nome escritorio-<nome>.local
//   atualizacao  atualização assinada entre os PCs
//   acesso       PIN da casa
//   hook         instala/remove o hook de notificação do Claude

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCore } from './lib/nucleo.mjs';
import { createClaude } from './lib/claude.mjs';
import { createAntigravity } from './lib/antigravity.mjs';
import { createGemini } from './lib/gemini.mjs';
import { createNetwork } from './lib/rede.mjs';
import { startMdns, slugOf } from './lib/mdns.mjs';
import { createUpdater } from './lib/atualizacao.mjs';
import { createAccess, pinToken, LOGIN_PAGE } from './lib/acesso.mjs';
import { createHookConfig } from './lib/hook.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

// rodando pela bandeja não tem janela: as mensagens vão pro escritorio.log
if (process.env.ESCRITORIO_LOG) {
  const stamp = () => new Date().toLocaleTimeString('pt-BR');
  // gravação imediata: o processo pode sair logo depois (reinício após atualizar)
  console.log = (...a) => { try { fs.appendFileSync(process.env.ESCRITORIO_LOG, `[${stamp()}] ${a.map(String).join(' ')}\n`); } catch {} };
}

// ---------------------------------------------------------------- configuração
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '')); } catch {}
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }

const PORT = Number(process.env.PORT || config.port || 4480);
const OWNER = String(process.env.OWNER || config.owner || os.userInfo().username);
const MACHINE = process.env.MACHINE || os.hostname(); // dois coletores no mesmo PC não viram duas alas
const HOME = os.homedir();
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const ACCESSORIES = ['nenhum', 'bone', 'oculos', 'laco', 'fones', 'coroa'];
const getProfile = () => ({ cor: /^#[0-9a-f]{6}$/i.test(config.cor || '') ? config.cor : '', acessorio: ACCESSORIES.includes(config.acessorio) ? config.acessorio : 'nenhum' });
const getPin = () => String(config.pin || '');

// ---------------------------------------------------------------- módulos
const updater = createUpdater({ appDir: APP_DIR, supervised: process.env.ESCRITORIO_SUPERVISOR === '1' });
const core = createCore({ owner: OWNER, showText: () => config.showText !== false });
const hookCfg = createHookConfig({ settingsPath: path.join(HOME, '.claude', 'settings.json'), appDir: APP_DIR, nodePath: process.execPath });
const claude = createClaude(core, { dir: path.join(HOME, '.claude', 'projects'), tempDir: os.tmpdir().toLowerCase(), hookInstalled: () => hookCfg.installed() });
const antigravity = createAntigravity(core, { dir: path.join(HOME, '.gemini', 'antigravity') });
const gemini = createGemini(core, { dir: path.join(HOME, '.gemini', 'tmp') });
const peerHeaders = () => (getPin() ? { 'x-escritorio-pin': pinToken(getPin()) } : {});
const net = createNetwork({ core, owner: OWNER, machine: MACHINE, port: PORT, version: updater.version, getProfile, peerHeaders, updater });
const access = createAccess({ getPin, myIps: net.myIps, strict: process.env.ESCRITORIO_TESTE_REMOTO === '1' });
const MDNS_NAME = `escritorio-${slugOf(OWNER)}.local`;

function health() {
  return {
    kind: 'health',
    claude: claude.health, antigravity: antigravity.health, gemini: gemini.health,
    hook: hookCfg.installed(), pin: !!getPin(), name: MDNS_NAME, port: PORT,
  };
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function sse(req, res, set, first) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  for (const m of first) res.write(`data: ${JSON.stringify(m)}\n\n`);
  set.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); set.delete(res); });
}
async function body(req, max = 64 * 1024) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > max) throw new Error('grande demais'); }
  return s;
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

function settingsView() {
  return { owner: OWNER, pin: getPin(), showText: config.showText !== false, ...getProfile(), accessories: ACCESSORIES,
    hook: hookCfg.installed(), hookCommand: hookCfg.command, name: MDNS_NAME, port: PORT };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // ---- login (pela rede, quando há PIN)
    if (p === '/login' && req.method === 'POST') {
      const pin = new URLSearchParams(await body(req)).get('pin');
      const r = access.login(req, pin);
      if (r.error) { res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_PAGE(r.error)); }
      res.writeHead(303, { 'Set-Cookie': r.cookie, Location: '/' });
      return res.end();
    }
    if (!access.allowed(req)) {
      if (p === '/' || p.endsWith('.html')) { res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_PAGE()); }
      res.writeHead(401); return res.end();
    }

    // ---- tempo real
    if (p === '/events') {
      return sse(req, res, core.clients, [
        { ...net.ownersMessage(), me: OWNER, version: updater.version, local: access.isLocal(req) },
        { kind: 'snapshot', sessions: net.allSessions() },
        ...net.allStats(),
        health(),
      ]);
    }
    if (p === '/peer-events') {
      if (req.headers['x-escritorio-owner']) net.onPeerArrived(access.remoteOf(req));
      return sse(req, res, core.peerClients, [
        net.hello(),
        { kind: 'snapshot', sessions: core.snapshot().map((s) => core.forNetwork({ kind: 'session', session: s }).session) },
        core.statsMessage(),
      ]);
    }
    if (p.startsWith('/update/')) {
      const f = updater.serve(p.slice('/update/'.length));
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': f.type }); return res.end(f.body);
    }

    // ---- só no próprio PC
    if (p === '/hook' && req.method === 'POST') {
      if (!access.localWrite(req)) { res.writeHead(403); return res.end(); }
      let payload = {}; try { payload = JSON.parse(await body(req)); } catch {}
      return json(res, 200, { ok: claude.onHook(payload) });
    }
    if (p === '/api/config') {
      if (req.method === 'GET') return access.isLocal(req) ? json(res, 200, settingsView()) : json(res, 403, {});
      if (req.method !== 'POST' || !access.localWrite(req)) return json(res, 403, {});
      const b = JSON.parse(await body(req));
      if ('pin' in b) {
        const pin = String(b.pin || '').trim();
        if (pin && !/^\d{4,8}$/.test(pin)) return json(res, 400, { error: 'O PIN precisa ter de 4 a 8 números.' });
        config.pin = pin;
      }
      if ('cor' in b) config.cor = /^#[0-9a-f]{6}$/i.test(b.cor) ? b.cor : '';
      if ('acessorio' in b) config.acessorio = ACCESSORIES.includes(b.acessorio) ? b.acessorio : 'nenhum';
      if ('showText' in b) config.showText = !!b.showText;
      saveConfig();
      core.write(core.clients, net.ownersMessage());
      core.write(core.peerClients, net.hello()); // os outros PCs recebem o visual novo
      core.write(core.clients, health());
      return json(res, 200, settingsView());
    }
    if (p === '/api/hook' && req.method === 'POST') {
      if (!access.localWrite(req)) return json(res, 403, {});
      const b = JSON.parse(await body(req));
      try {
        if (b.action === 'install') hookCfg.install(); else if (b.action === 'uninstall') hookCfg.uninstall();
      } catch (e) { return json(res, 500, { error: 'Não consegui mexer no settings.json do Claude: ' + e.message }); }
      console.log(b.action === 'install' ? 'hook do Claude instalado' : 'hook do Claude removido');
      core.write(core.clients, health());
      return json(res, 200, settingsView());
    }

    // ---- arquivos da página
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    return res.end(data);
  } catch (e) {
    if (!res.headersSent) { res.writeHead(e.code === 'ENOENT' ? 404 : 500); res.end(e.code === 'ENOENT' ? 'não encontrado' : 'erro'); }
  }
});

server.on('error', (e) => {
  console.log(e.code === 'EADDRINUSE' ? `a porta ${PORT} já está em uso (o escritório já está rodando?)` : e.message);
  process.exit(1);
});

// ---------------------------------------------------------------- largada
const SAFETY_MS = 30000; // rede de segurança caso o Windows perca algum aviso
// a página já abre enquanto o histórico do dia é lido; as sessões vão aparecendo
server.listen(PORT, '0.0.0.0', () => {
  const lan = [...net.myIps].filter((ip) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(ip));
  console.log(`Escritório IA de ${OWNER}${getPin() ? ' (rede protegida por PIN)' : ''}`);
  console.log(`  aqui:  http://localhost:${PORT}`);
  console.log(`  nome:  http://${MDNS_NAME}:${PORT}`);
  for (const ip of lan) console.log(`  rede:  http://${ip}:${PORT}`);
});
const t0 = Date.now();
await claude.scan(true).catch(() => {});
antigravity.scan();
await gemini.scan(true).catch(() => {});
const cw = claude.watch(), aw = antigravity.watch();
gemini.watch();
setInterval(() => claude.scan().catch(() => {}), cw ? SAFETY_MS : 800);
setInterval(() => antigravity.scan(), aw ? SAFETY_MS : 1500);
setInterval(() => gemini.scan().catch(() => {}), SAFETY_MS);
setInterval(() => claude.tick(), 1000);
setInterval(() => core.flushStats(), 3000);
setInterval(() => core.expire(), 60000);
let lastHealth = '';
setInterval(() => {
  const h = JSON.stringify({ ...health(), claude: { ...claude.health, lastLine: 0 }, antigravity: { ...antigravity.health, lastScan: 0 } });
  if (h !== lastHealth) { lastHealth = h; core.write(core.clients, health()); }
}, 5000);

net.startDiscovery();
for (const u of Array.isArray(config.peers) ? config.peers : []) net.connect(u);
startMdns(MDNS_NAME);

console.log(`modo: ${cw ? 'aviso do Windows' : 'varredura'} (Claude), ${aw ? 'aviso do Windows' : 'varredura'} (Antigravity)`);
console.log(`histórico de hoje lido em ${((Date.now() - t0) / 1000).toFixed(1)} s: ${core.snapshot().length} sessões recentes`);
