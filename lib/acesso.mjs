// PIN da casa: quem acessa pela rede precisa dele pra ver qualquer coisa.
// No próprio PC (localhost) nunca pede. Os coletores mandam o PIN (em hash) entre si.
import crypto from 'node:crypto';

export const pinToken = (pin) => crypto.createHash('sha256').update('escritorio-ia:' + String(pin)).digest('hex').slice(0, 32);

export function createAccess({ getPin, myIps, strict = false }) {
  const fails = new Map(); // ip -> { n, until }

  const remoteOf = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  // strict (só em teste): o próprio IP de rede conta como outro aparelho
  const isLocal = (req) => { const r = remoteOf(req); return r === '127.0.0.1' || r === '::1' || (!strict && myIps.has(r)); };

  function cookieToken(req) {
    const m = /(?:^|;\s*)escritorio_pin=([0-9a-f]{32})/.exec(req.headers.cookie || '');
    return m ? m[1] : '';
  }
  function allowed(req) {
    const pin = getPin();
    if (!pin || isLocal(req)) return true;
    const tok = pinToken(pin);
    const given = req.headers['x-escritorio-pin'] || cookieToken(req);
    return typeof given === 'string' && given.length === tok.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(tok));
  }

  // tentativa de login: devolve o cookie ou o motivo da recusa
  function login(req, pinTry) {
    const ip = remoteOf(req), now = Date.now();
    const f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > now) return { error: `muitas tentativas, espere ${Math.ceil((f.until - now) / 1000)} s` };
    if (String(pinTry || '') !== String(getPin() || '')) {
      f.n++;
      if (f.n >= 5) { f.until = now + 60000; f.n = 0; }
      fails.set(ip, f);
      return { error: 'PIN errado' };
    }
    fails.delete(ip);
    return { cookie: `escritorio_pin=${pinToken(getPin())}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` };
  }

  // pedidos que mudam alguma coisa: só do próprio PC e só vindos da própria página
  // (o cabeçalho próprio obriga o navegador a pedir licença antes, o que bloqueia sites de fora)
  function localWrite(req) {
    if (!isLocal(req) || req.headers['x-escritorio'] !== '1') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return true;
    try { return myIps.has(new URL(origin).hostname); } catch { return false; }
  }

  return { allowed, login, isLocal, localWrite, remoteOf };
}

export const LOGIN_PAGE = (error = '') => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Escritório IA</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #17130f; color: #f2e9df; font-family: system-ui, sans-serif; padding: 16px; }
  form { background: rgba(28,23,19,.9); border: 1px solid rgba(255,240,220,.09); border-radius: 14px; padding: 22px; width: min(320px, 100%); }
  h1 { font-size: 17px; margin: 0 0 4px; } p { color: #a8998a; font-size: 13px; margin: 0 0 14px; }
  input { width: 100%; box-sizing: border-box; font-size: 20px; letter-spacing: 4px; text-align: center; padding: 10px; border-radius: 9px; border: 1px solid #4a382c; background: #120e0b; color: #f2e9df; }
  button { margin-top: 12px; width: 100%; padding: 10px; border: 0; border-radius: 9px; background: #e07a52; color: #1a120d; font-weight: 700; font-size: 14px; cursor: pointer; }
  .err { color: #ff9b8a; font-size: 13px; margin-top: 10px; min-height: 1em; }
</style></head>
<body><form method="post" action="/login">
  <h1>Escritório IA</h1><p>Digite o PIN da casa pra ver o escritório.</p>
  <input name="pin" type="password" inputmode="numeric" autocomplete="current-password" autofocus required>
  <button>Entrar</button><div class="err">${String(error).replace(/[<>&"]/g, '')}</div>
</form></body></html>`;
