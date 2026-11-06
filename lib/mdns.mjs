// Nome amigável na rede (mDNS): responde "escritorio-<nome>.local" com o IP da placa
// que está na mesma rede de quem perguntou, pra não devolver IPs virtuais (WSL, Hyper-V).
import dgram from 'node:dgram';
import os from 'node:os';

const ADDR = '224.0.0.251';

export function slugOf(owner) {
  return String(owner).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pc';
}

const ipv4s = () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
const ipNum = (ip) => ip.split('.').reduce((a, v) => (a << 8) + Number(v), 0) >>> 0;
export function ipFor(remote, all = ipv4s()) {
  const same = all.find((i) => ((ipNum(i.address) ^ ipNum(remote)) & ipNum(i.netmask)) === 0);
  return (same || all.find((i) => /^192\.168\./.test(i.address)) || all[0])?.address;
}

export function readName(buf, off) {
  const labels = [];
  let jumped = false, next = off;
  for (let guard = 0; guard < 64; guard++) {
    const len = buf[off];
    if (len === undefined) return null;
    if (len === 0) { if (!jumped) next = off + 1; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) next = off + 2; off = ((len & 0x3f) << 8) | buf[off + 1]; jumped = true; continue; }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join('.').toLowerCase(), next };
}
export function encodeName(name) {
  const parts = name.split('.').map((l) => { const b = Buffer.from(l); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

// devolve { ip, unicast, id } se a pergunta for pelo nosso nome (tipo A ou ANY)
export function matchQuery(buf, name) {
  if (buf.length < 12 || (buf.readUInt16BE(2) & 0x8000)) return null; // só perguntas
  const qd = buf.readUInt16BE(4);
  let off = 12;
  for (let q = 0; q < qd; q++) {
    const n = readName(buf, off);
    if (!n || n.next + 4 > buf.length) return null;
    const type = buf.readUInt16BE(n.next), klass = buf.readUInt16BE(n.next + 2);
    off = n.next + 4;
    if (n.name === name && (type === 1 || type === 255)) return { unicast: !!(klass & 0x8000), id: buf.readUInt16BE(0) };
  }
  return null;
}
export function buildAnswer(name, ip, id = 0) {
  const rr = Buffer.alloc(14);
  rr.writeUInt16BE(1, 0);        // tipo A
  rr.writeUInt16BE(0x8001, 2);   // classe IN + cache-flush
  rr.writeUInt32BE(120, 4);      // TTL
  rr.writeUInt16BE(4, 8);
  ip.split('.').forEach((v, k) => rr.writeUInt8(Number(v), 10 + k));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  return Buffer.concat([header, encodeName(name), rr]);
}

export function startMdns(name) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => console.log('nome .local indisponível:', e.message));
  sock.on('message', (buf, rinfo) => {
    const q = matchQuery(buf, name);
    if (!q) return;
    const ip = ipFor(rinfo.address);
    if (!ip) return;
    const legacy = rinfo.port !== 5353; // resolvedor simples: responde direto, com o mesmo id
    const answer = buildAnswer(name, ip, legacy ? q.id : 0);
    if (legacy || q.unicast) sock.send(answer, rinfo.port, rinfo.address, () => {});
    else { try { sock.setMulticastInterface(ip); } catch {} sock.send(answer, 5353, ADDR, () => {}); }
  });
  sock.bind(5353, () => {
    for (const i of ipv4s()) { try { sock.addMembership(ADDR, i.address); } catch {} }
    try { sock.setMulticastTTL(255); } catch {}
  });
  return sock;
}
