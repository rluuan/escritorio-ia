// Chamado pelo Claude (hook de notificação) quando ele pede permissão ou espera você.
// Só repassa o aviso pro coletor local e sai. Nunca bloqueia nem falha o Claude.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let port = 4480;
try { port = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8').replace(/^﻿/, '')).port || 4480; } catch {}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  try {
    await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-escritorio': '1' },
      body: input,
      signal: AbortSignal.timeout(1500),
    });
  } catch {}
  process.exit(0);
});
setTimeout(() => process.exit(0), 3000); // nunca segura o Claude
