// Atualização assinada entre os PCs.
// Só o PC que tem chave-privada.pem gera versões novas. Os outros só aceitam arquivos
// cuja assinatura bate com chave-publica.pem e cujo caminho está na lista permitida.
// Sem chave-publica.pem a atualização automática fica desligada. As duas saem de: node gerar-chave.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256 } from './util.mjs';

// caminhos que podem vir numa atualização (nunca .cmd, config.json ou as chaves)
export const UPDATABLE = /^(server\.mjs|hook\.mjs|bandeja\.ps1|README\.md|lib\/[a-z0-9-]+\.mjs|public\/[a-z0-9-]+\.(html|js|css|json|svg))$/;

export function verifyManifest(m, pubkey) {
  if (!pubkey || !m || typeof m.payload !== 'string' || typeof m.sig !== 'string') return null;
  try {
    if (!crypto.verify(null, Buffer.from(m.payload), pubkey, Buffer.from(m.sig, 'base64'))) return null;
    const p = JSON.parse(m.payload);
    if (!Number.isFinite(p.version) || !p.files || typeof p.files !== 'object') return null;
    if (Object.keys(p.files).some((f) => !UPDATABLE.test(f))) return null;
    return { raw: m, version: p.version, files: p.files };
  } catch { return null; }
}

export function createUpdater({ appDir, supervised }) {
  const MANIFEST = path.join(appDir, 'versao.json');
  const KEY = path.join(appDir, 'chave-privada.pem');
  let pubkey = null;
  try { pubkey = crypto.createPublicKey(fs.readFileSync(path.join(appDir, 'chave-publica.pem'))); } catch {}

  function listFiles() {
    const out = [];
    for (const f of ['server.mjs', 'hook.mjs', 'bandeja.ps1', 'README.md']) if (fs.existsSync(path.join(appDir, f))) out.push(f);
    for (const sub of ['lib', 'public']) {
      try { for (const f of fs.readdirSync(path.join(appDir, sub))) if (UPDATABLE.test(`${sub}/${f}`)) out.push(`${sub}/${f}`); } catch {}
    }
    return out.sort();
  }
  const hashes = () => Object.fromEntries(listFiles().map((f) => [f, sha256(fs.readFileSync(path.join(appDir, f)))]));
  function read() { try { return verifyManifest(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')), pubkey); } catch { return null; } }

  // no PC com a chave privada: se algum arquivo mudou, assina uma versão nova ao iniciar
  function signIfOwner() {
    if (!pubkey || !fs.existsSync(KEY)) return read();
    const cur = read();
    const files = hashes();
    if (cur && JSON.stringify(cur.files) === JSON.stringify(files)) return cur;
    const payload = JSON.stringify({ version: Date.now(), files });
    const raw = { payload, sig: crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(fs.readFileSync(KEY))).toString('base64') };
    fs.writeFileSync(MANIFEST, JSON.stringify(raw, null, 2));
    console.log('versão nova assinada');
    return verifyManifest(raw, pubkey);
  }

  const manifest = signIfOwner();
  const version = manifest?.version || 0;
  let updating = false;

  async function updateFrom(url, theirVersion, headers = {}) {
    if (updating || !(theirVersion > version)) return;
    updating = true;
    try {
      const m = verifyManifest(await (await fetch(url + '/update/versao.json', { headers })).json(), pubkey);
      if (!m) throw new Error('assinatura inválida, ignorando');
      if (!(m.version > version)) throw new Error('versão não é mais nova');
      const blobs = {};
      for (const [f, hash] of Object.entries(m.files)) {
        const r = await fetch(url + '/update/' + f, { headers });
        if (!r.ok) throw new Error(`não consegui baixar ${f}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (sha256(buf) !== hash) throw new Error(`${f} não bate com a assinatura`);
        blobs[f] = buf;
      }
      // só escreve depois de tudo baixado e conferido
      const mine = hashes();
      for (const [f, buf] of Object.entries(blobs)) {
        if (mine[f] === m.files[f]) continue;
        const dest = path.join(appDir, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest + '.novo', buf);
        fs.renameSync(dest + '.novo', dest);
      }
      fs.writeFileSync(MANIFEST, JSON.stringify(m.raw, null, 2));
      console.log(`atualizado para a versão ${new Date(m.version).toLocaleString('pt-BR')}`);
      if (supervised) { console.log('reiniciando...'); setTimeout(() => process.exit(42), 300); }
      else console.log('feche e abra o escritório de novo pra usar a versão nova');
    } catch (e) {
      console.log(`atualização de ${url} falhou: ${e.message}`);
      updating = false;
    }
  }

  // o que outro PC pode baixar daqui: o manifesto e os arquivos listados nele, se não mudaram desde a assinatura
  function serve(f) {
    if (!manifest) return null;
    if (f === 'versao.json') return { type: 'application/json', body: JSON.stringify(manifest.raw) };
    if (!(f in manifest.files)) return null;
    try {
      const body = fs.readFileSync(path.join(appDir, f));
      return sha256(body) === manifest.files[f] ? { type: 'application/octet-stream', body } : null;
    } catch { return null; }
  }

  return { version, updateFrom, serve };
}
