// Testes com amostras montadas (nenhuma conversa real). Rodar: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCore } from '../lib/nucleo.mjs';
import { createClaude } from '../lib/claude.mjs';
import { extractUserText } from '../lib/antigravity.mjs';
import { rebuildGeminiSession, geminiState } from '../lib/gemini.mjs';
import { verifyManifest, UPDATABLE } from '../lib/atualizacao.mjs';
import { matchQuery, buildAnswer, encodeName, slugOf, ipFor } from '../lib/mdns.mjs';
import { cleanPrompt, toolName } from '../lib/util.mjs';

const core = () => createCore({ owner: 'Teste', showText: () => true });

// ------------------------------------------------------------ Antigravity
function agPayload(text, { lengthByteLooksLikeLetter = false } = {}) {
  const t = Buffer.from(text);
  const hex = Buffer.from(crypto.randomBytes(16).toString('hex'));
  const copy = Buffer.concat([Buffer.from([0x12, t.length]), t]);
  const extra = lengthByteLooksLikeLetter ? Buffer.from([0x0a]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0x08, 0x0e, 0x22, 0x20]), hex, extra, copy, Buffer.from([0x1a, t.length]), t, Buffer.from([0x20, 0x01])]);
}
test('Antigravity: acha o texto do pedido no protobuf', () => {
  assert.equal(extractUserText(agPayload('arruma o layout da página de login')), 'arruma o layout da página de login');
  assert.equal(extractUserText(agPayload('oi')), 'oi');
});
test('Antigravity: texto com acento e emoji', () => {
  assert.equal(extractUserText(agPayload('ação rápida ✅ agora')), 'ação rápida ✅ agora');
});

// ------------------------------------------------------------ Claude
function tmpClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-claude-'));
  fs.mkdirSync(path.join(dir, 'proj'));
  return dir;
}
const line = (o) => JSON.stringify({ sessionId: 's1', cwd: 'C:\\proj', entrypoint: 'claude-desktop', ...o }) + '\n';
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('Claude: pedido, ferramenta, resposta e estatísticas', async () => {
  const dir = tmpClaude();
  const c = core();
  const cl = createClaude(c, { dir, tempDir: 'z:\\nada', hookInstalled: () => false });
  fs.writeFileSync(path.join(dir, 'proj', 's1.jsonl'),
    line({ type: 'user', timestamp: ago(60000), message: { content: 'faz um gráfico <system-reminder>x</system-reminder>' } }) +
    line({ type: 'assistant', timestamp: ago(50000), message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, content: [{ type: 'tool_use', id: 't1', name: 'mcp__srv__ler' }] } }) +
    line({ type: 'user', timestamp: ago(40000), message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }) +
    line({ type: 'assistant', timestamp: ago(30000), message: { id: 'm2', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 7 }, content: [{ type: 'text', text: 'pronto, gráfico feito' }] } }));
  await cl.scan(true);
  const s = c.sessions.get('cc:s1');
  assert.equal(s.state, 'done');
  assert.equal(s.source, 'desktop');
  assert.equal(s.lastPrompt, 'faz um gráfico');
  assert.equal(s.lastReply, 'pronto, gráfico feito');
  assert.deepEqual(s.tokens, { in: 11, out: 12, cache: 100 });
  assert.equal(c.stats.prompts, 1);
  assert.equal(c.stats.tools.ler, 1);
  assert.ok(Math.abs(c.stats.workMs - 30000) < 50, 'tempo de trabalho = do pedido até o fim');
  assert.equal(s.spans.length, 1);
});

test('Claude: pergunta pra você e permissão viram "esperando você"', async () => {
  const dir = tmpClaude();
  const c = core();
  let hook = false;
  const cl = createClaude(c, { dir, tempDir: 'z:\\nada', hookInstalled: () => hook });
  const f = path.join(dir, 'proj', 's1.jsonl');
  fs.writeFileSync(f,
    line({ type: 'user', timestamp: ago(20000), message: { content: 'muda o arquivo' } }) +
    line({ type: 'assistant', timestamp: ago(10000), message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Edit' }] } }));
  await cl.scan(true);
  cl.tick();
  assert.equal(c.sessions.get('cc:s1').state, 'waiting', 'Edit parado há 10 s sem hook');
  // resultado da ferramenta = a pessoa aprovou
  fs.appendFileSync(f, line({ type: 'user', timestamp: ago(0), message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }));
  await cl.scan();
  assert.equal(c.sessions.get('cc:s1').state, 'tool');

  // com hook instalado a heurística das ferramentas rápidas desliga, mas o aviso do hook vale
  hook = true;
  fs.appendFileSync(f, line({ type: 'assistant', timestamp: ago(9000), message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'Write' }] } }));
  await cl.scan();
  cl.tick();
  assert.equal(c.sessions.get('cc:s1').state, 'tool');
  assert.ok(cl.onHook({ session_id: 's1', message: 'Claude needs your permission to use Write', notification_type: 'permission_prompt' }));
  assert.equal(c.sessions.get('cc:s1').state, 'waiting');
  assert.equal(cl.onHook({ session_id: 's1', message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }), false);
});

test('Claude: AskUserQuestion espera mesmo com hook', async () => {
  const dir = tmpClaude();
  const c = core();
  const cl = createClaude(c, { dir, tempDir: 'z:\\nada', hookInstalled: () => true });
  fs.writeFileSync(path.join(dir, 'proj', 's1.jsonl'),
    line({ type: 'user', timestamp: ago(9000), message: { content: 'escolhe pra mim' } }) +
    line({ type: 'assistant', timestamp: ago(5000), message: { id: 'm1', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion' }] } }));
  await cl.scan(true);
  cl.tick();
  assert.equal(c.sessions.get('cc:s1').waitingFor, 'tem uma pergunta pra você');
});

test('Claude: subagentes viram ajudantes enquanto rodam', async () => {
  const dir = tmpClaude();
  const c = core();
  const cl = createClaude(c, { dir, tempDir: 'z:\\nada', hookInstalled: () => true });
  const f = path.join(dir, 'proj', 's1.jsonl');
  fs.writeFileSync(f,
    line({ type: 'user', timestamp: ago(9000), message: { content: 'pesquisa isso' } }) +
    line({ type: 'assistant', timestamp: ago(8000), message: { id: 'm1', content: [
      { type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'Procurar no código', subagent_type: 'Explore' } },
      { type: 'tool_use', id: 'a2', name: 'Agent', input: { description: 'Ler a documentação' } }] } }));
  await cl.scan(true);
  assert.deepEqual(c.sessions.get('cc:s1').helpers.map((h) => h.desc), ['Procurar no código', 'Ler a documentação']);
  fs.appendFileSync(f, line({ type: 'user', timestamp: ago(0), message: { content: [{ type: 'tool_result', tool_use_id: 'a1' }] } }));
  await cl.scan();
  assert.deepEqual(c.sessions.get('cc:s1').helpers.map((h) => h.desc), ['Ler a documentação']);
});

test('Claude: sessões de SDK na pasta Temp são ignoradas', async () => {
  const dir = tmpClaude();
  const c = core();
  const cl = createClaude(c, { dir, tempDir: 'c:\\temp', hookInstalled: () => false });
  fs.writeFileSync(path.join(dir, 'proj', 's1.jsonl'), line({ type: 'user', cwd: 'C:\\Temp\\x', timestamp: ago(1000), message: { content: 'ping' } }));
  await cl.scan(true);
  assert.equal(c.sessions.size, 0);
});

// ------------------------------------------------------------ Gemini CLI
test('Gemini CLI: monta o estado a partir das linhas', () => {
  const lines = [
    JSON.stringify({ sessionId: 'g1', kind: 'main' }),
    JSON.stringify({ $set: { messages: [{ id: '1', type: 'user', content: [{ text: '<session_context>contexto</session_context>' }] }] } }),
    JSON.stringify({ $set: { messages: [
      { id: '1', type: 'user', content: [{ text: '<session_context>contexto</session_context>' }] },
      { id: '2', type: 'user', content: [{ text: 'lista os arquivos' }] },
      { id: '3', type: 'gemini', content: '', toolCalls: [{ name: 'list_directory', status: 'executing' }] }] } }),
  ];
  let st = geminiState(rebuildGeminiSession(lines));
  assert.equal(st.state, 'tool'); assert.equal(st.tool, 'list_directory'); assert.equal(st.prompt, 'lista os arquivos');
  lines.push(JSON.stringify({ id: '3', type: 'gemini', content: 'aqui estão', toolCalls: [{ name: 'list_directory', status: 'success' }] }));
  st = geminiState(rebuildGeminiSession(lines));
  assert.equal(st.state, 'done'); assert.equal(st.reply, 'aqui estão');
  assert.equal(geminiState(rebuildGeminiSession(lines.slice(0, 2))), null, 'só o contexto não é pedido');
});

// ------------------------------------------------------------ atualização
test('Atualização: só aceita assinatura certa e caminhos permitidos', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const sign = (p) => ({ payload: JSON.stringify(p), sig: crypto.sign(null, Buffer.from(JSON.stringify(p)), privateKey).toString('base64') });
  assert.ok(verifyManifest(sign({ version: 2, files: { 'server.mjs': 'a', 'lib/nucleo.mjs': 'b', 'public/app.js': 'c' } }), publicKey));
  assert.equal(verifyManifest(sign({ version: 2, files: { 'iniciar.cmd': 'a' } }), publicKey), null);
  assert.equal(verifyManifest(sign({ version: 2, files: { '../fora.mjs': 'a' } }), publicKey), null);
  assert.equal(verifyManifest(sign({ version: 2, files: { 'server.mjs': 'a' } }), crypto.generateKeyPairSync('ed25519').publicKey), null, 'outra chave');
  assert.equal(verifyManifest(sign({ version: 2, files: { 'server.mjs': 'a' } })), null, 'sem chave pública');
  for (const bad of ['config.json', 'chave-privada.pem', 'lib/../x.mjs', 'public/x.exe', 'node/node.exe']) assert.ok(!UPDATABLE.test(bad), bad);
});

// ------------------------------------------------------------ nome .local
test('mDNS: responde só pelo próprio nome', () => {
  const q = Buffer.concat([Buffer.from([0, 7, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), encodeName('escritorio-ana.local'), Buffer.from([0, 1, 0x80, 1])]);
  assert.deepEqual(matchQuery(q, 'escritorio-ana.local'), { unicast: true, id: 7 });
  assert.equal(matchQuery(q, 'escritorio-bia.local'), null);
  const a = buildAnswer('escritorio-ana.local', '192.168.1.7', 7);
  assert.deepEqual([...a.subarray(a.length - 4)], [192, 168, 1, 7]);
  assert.equal(slugOf('Biá Maria'), 'bia-maria');
  const nics = [{ address: '172.20.0.5', netmask: '255.255.240.0' }, { address: '192.168.1.7', netmask: '255.255.255.0' }];
  assert.equal(ipFor('192.168.1.20', nics), '192.168.1.7');
});

test('utilidades', () => {
  assert.equal(toolName('mcp__Claude_Browser__browser_batch'), 'browser_batch');
  assert.equal(cleanPrompt('<command-name>/x</command-name> oi   tudo bem'), 'oi tudo bem');
});
