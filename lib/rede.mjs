// Outros PCs na rede: cada coletor conecta no /peer-events dos outros e repassa as sessões
// deles pros navegadores. A descoberta é automática por broadcast UDP.
import dgram from 'node:dgram';
import os from 'node:os';

const DISCOVERY_PORT = 4478;

export function createNetwork({ core, owner, machine, port, version, getProfile, peerHeaders, updater }) {
  /** @type {Map<string, {owner:string, machine:string, profile:any, sessions:Map<string,any>, stats:any, ok:boolean, error:string}>} */
  const peers = new Map();
  const myIps = new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => i.address));

  function owners() {
    const list = [{ owner, self: true, online: true, ...getProfile() }];
    for (const [url, p] of peers) if (p.owner && p.owner !== owner) list.push({ owner: p.owner, url, online: p.ok, ...(p.profile || {}), error: p.error });
    return list;
  }
  const ownersMessage = () => ({ kind: 'owners', owners: owners() });

  function allSessions() {
    const out = core.snapshot();
    for (const p of peers.values()) out.push(...p.sessions.values());
    return out;
  }
  function allStats() {
    const out = [core.statsMessage()];
    for (const p of peers.values()) if (p.ok && p.stats) out.push({ kind: 'stats', owner: p.owner, stats: p.stats });
    return out;
  }

  function connect(url) {
    url = url.replace(/\/+$/, '');
    if (peers.has(url)) return;
    const peer = { owner: '', machine: '', profile: null, sessions: new Map(), stats: null, ok: false, error: '' };
    peers.set(url, peer);
    console.log(`conectando em ${url}`);

    const loop = async () => {
      while (true) {
        try {
          const res = await fetch(url + '/peer-events', { headers: { 'x-escritorio-owner': owner, ...peerHeaders() } });
          if (res.status === 401) { peer.error = 'PIN diferente'; throw new Error('pin'); }
          if (!res.ok || !res.body) throw new Error('http ' + res.status);
          peer.ok = true; peer.error = '';
          let buf = '';
          const dec = new TextDecoder();
          for await (const chunk of res.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const line = block.split('\n').find((l) => l.startsWith('data: '));
              if (!line) continue;
              let msg; try { msg = JSON.parse(line.slice(6)); } catch { continue; }
              if (msg.kind === 'hello') {
                if (msg.owner === owner || msg.machine === machine) { peers.delete(url); return; } // sou eu mesmo
                const dup = [...peers].some(([u, p]) => u !== url && p.owner === msg.owner);
                if (dup) { peers.delete(url); return; } // mesmo PC por outro IP
                peer.owner = msg.owner; peer.machine = msg.machine; peer.profile = msg.profile || null;
                core.write(core.clients, ownersMessage());
                if (msg.version > version) updater.updateFrom(url, msg.version, peerHeaders());
              } else if (msg.kind === 'snapshot') {
                for (const id of peer.sessions.keys()) core.write(core.clients, { kind: 'remove', id });
                peer.sessions = new Map(msg.sessions.map((s) => [s.id, s]));
                for (const s of peer.sessions.values()) core.write(core.clients, { kind: 'session', session: s, event: null });
              } else if (msg.kind === 'session') {
                peer.sessions.set(msg.session.id, msg.session);
                core.write(core.clients, msg);
              } else if (msg.kind === 'remove') {
                peer.sessions.delete(msg.id);
                core.write(core.clients, msg);
              } else if (msg.kind === 'stats') {
                peer.stats = msg.stats;
                core.write(core.clients, { kind: 'stats', owner: peer.owner, stats: msg.stats });
              }
            }
          }
        } catch {}
        if (peer.ok) {
          peer.ok = false;
          for (const id of peer.sessions.keys()) core.write(core.clients, { kind: 'remove', id });
          peer.sessions.clear();
        }
        core.write(core.clients, ownersMessage());
        await new Promise((r) => setTimeout(r, 4000));
      }
    };
    loop();
  }

  // descoberta automática: cada coletor anuncia "estou aqui" na rede local a cada 5 s
  function startDiscovery() {
    const disco = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    disco.on('message', (buf, rinfo) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.app !== 'escritorio-ia' || m.owner === owner || m.machine === machine) return;
      if (myIps.has(rinfo.address) && m.port === port) return;
      if ([...peers.values()].some((p) => p.owner === m.owner)) return; // já conectado
      connect(`http://${rinfo.address}:${m.port}`);
    });
    disco.on('error', (e) => console.log('descoberta UDP indisponível:', e.message));
    disco.bind(DISCOVERY_PORT, () => {
      disco.setBroadcast(true);
      // broadcast dirigido por placa de rede (ex.: 192.168.1.255), além do genérico
      const targets = () => {
        const out = new Set(['255.255.255.255']);
        for (const i of Object.values(os.networkInterfaces()).flat()) {
          if (!i || i.family !== 'IPv4' || i.internal) continue;
          const a = i.address.split('.').map(Number), mk = i.netmask.split('.').map(Number);
          out.add(a.map((v, k) => (v & mk[k]) | (~mk[k] & 255)).join('.'));
        }
        return [...out];
      };
      const announce = () => {
        const msg = Buffer.from(JSON.stringify({ app: 'escritorio-ia', owner, machine, port }));
        for (const t of targets()) disco.send(msg, DISCOVERY_PORT, t, () => {});
      };
      announce();
      setInterval(announce, 5000);
    });
  }

  // outro coletor conectou aqui: se eu ainda não conheço ele, conecto de volta
  function onPeerArrived(remote) {
    if (!remote || myIps.has(remote)) return;
    const known = [...peers.keys()].some((u) => u.includes(`//${remote}:`));
    if (!known) setTimeout(() => connect(`http://${remote}:${port}`), 500); // porta anunciada por UDP; sem UDP, a padrão
  }

  const hello = () => ({ kind: 'hello', owner, machine, version, profile: getProfile() });

  return { peers, myIps, owners, ownersMessage, allSessions, allStats, connect, startDiscovery, onPeerArrived, hello };
}
