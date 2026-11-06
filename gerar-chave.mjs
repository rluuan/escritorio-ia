// Cria o par de chaves da atualização automática assinada.
// Rode uma vez, no PC que vai publicar versões novas:  node gerar-chave.mjs
//   chave-privada.pem  fica só nesse PC (nunca envie, nunca suba pro Git)
//   chave-publica.pem  vai junto em todas as cópias que você entregar
import fs from 'node:fs';
import crypto from 'node:crypto';

if (fs.existsSync('chave-privada.pem')) {
  console.log('chave-privada.pem já existe. Apague antes se quiser trocar de chave (as cópias antigas param de aceitar suas versões).');
  process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync('chave-privada.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync('chave-publica.pem', publicKey.export({ type: 'spki', format: 'pem' }));
console.log('Pronto: chave-privada.pem (guarde) e chave-publica.pem (vai junto nas cópias).');
