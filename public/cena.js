// Cena 3D do escritório: sala, mesas, bonecos, ajudantes, luz do dia e animação.
// Os painéis (detalhe, hoje, configurações, avisos) ficam em ui.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createUI, esc } from './ui.js';

const SRC = {
  desktop:     { color: 0xe07a52, name: 'Claude Desktop' },
  terminal:    { color: 0xd6a93a, name: 'Terminal' },
  sdk:         { color: 0x2fb5a2, name: 'Agent SDK' },
  antigravity: { color: 0x7b86ff, name: 'Antigravity' },
  gemini:      { color: 0x4fb0e8, name: 'Gemini CLI' },
};
for (const v of Object.values(SRC)) v.css = '#' + v.color.toString(16).padStart(6, '0');
const WAIT = 0xffb648;
const PERSON_DEFAULT = ['#e07a52', '#c86fb4', '#4fb0e8', '#6fcf8a'];
const ZONE_TINT = [0x5a3f33, 0x3a4a52, 0x4b3f5c, 0x3f5240];
const COLS = 3, DX = 3.8, DZ = 3.2, ZONE_W = COLS * DX + 2.4, LOUNGE_W = 4;
const WALK_SPEED = 2.6;            // unidades por segundo
const Y_CHAIR = -0.08, Y_STAND = -0.5;
const MIN_PROMPT_MS = 4000;        // o balão do pedido fica pelo menos isso antes do "pronto"
const MIN_DESK_MS = 2500;          // tempo mínimo na mesa antes de voltar
const DONE_LINGER_MS = 2500;       // depois do "pronto", espera isso e volta pro sofá
const SLEEP_AFTER_MS = 10 * 60 * 1000; // ninguém trabalhando por 10 min: o escritório "dorme"
const HELPER_SPOTS = [[-1.62, 0.25], [1.62, 0.25], [-1.62, 1.25], [1.62, 1.25]];

const ui = createUI({ SRC, onFocusSession: (id) => focusAgent(id) });

// ------------------------------------------------------------ renderer
const host = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
host.appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.domElement.style.cssText = 'position:fixed;inset:0;pointer-events:none';
host.appendChild(labels.domElement);

const scene = new THREE.Scene();
const BG_DAY = new THREE.Color(0x17130f), BG_NIGHT = new THREE.Color(0x0c0b0d);
scene.background = BG_DAY.clone();
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
camera.position.set(22, 20, 22);
const controls = new OrbitControls(camera, renderer.domElement);
controls.minPolarAngle = 0.6; controls.maxPolarAngle = 1.1;
controls.minZoom = 0.5; controls.maxZoom = 3;
controls.enableDamping = true;

const hemi = new THREE.HemisphereLight(0xffe9d2, 0x2a1f18, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe2c0, 1.6);
sun.position.set(14, 22, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -34; sun.shadow.camera.right = 34;
sun.shadow.camera.top = 34; sun.shadow.camera.bottom = -34;
sun.shadow.bias = -0.0005;
scene.add(sun);

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.02, ...o });
const rbox = (w, h, d, r, m) => {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 4, r), m);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
};
const label = (el, obj, pos) => { const l = new CSS2DObject(el); l.position.copy(pos); obj.add(l); return l; };
const V = (x, z) => new THREE.Vector3(x, 0, z);
const glassMat = mat(0x9fc6e6, { emissive: 0x6d93b8, emissiveIntensity: 0.55, roughness: 0.2 });

// ------------------------------------------------------------ pessoas (cor e acessório)
let me = '';
let ownerInfo = [];
let pageVersion = null;
function profileOf(owner) {
  const o = ownerInfo.find((x) => x.owner === owner) || {};
  const i = Math.max(0, ownerOrder().indexOf(owner));
  return { cor: o.cor || PERSON_DEFAULT[i % PERSON_DEFAULT.length], acessorio: o.acessorio || 'nenhum', custom: !!o.cor };
}
function ownerOrder() {
  const list = [...new Set([me, ...ownerInfo.map((o) => o.owner), ...slotsByOwner.keys()].filter(Boolean))];
  return list.length ? list : ['…'];
}

// ------------------------------------------------------------ layout
// Cada ala: 3 colunas de mesas no fundo, corredor, e a área de descanso na frente
// (dois sofás frente a frente com mesinha no meio, pufes, e lugares em pé).
let L = null; // geometria atual

function computeLayout(owners) {
  const R = Math.max(2, ...owners.map((o) => Math.ceil((slotsByOwner.get(o) || []).length / COLS)));
  const W = LOUNGE_W + owners.length * ZONE_W + 1;
  const D = 3.0 + (R - 1) * DZ + 2.05 + 2.6 + 3.6 + 0.6;
  const x0 = -W / 2, z0 = -D / 2;
  const zDesk0 = z0 + 3.0;
  const zA = zDesk0 + (R - 1) * DZ + 2.05;  // corredor entre mesas e descanso
  const zLc = zA + 2.6;                       // centro da área de descanso
  const zE = zLc + 3.6;                       // borda da frente
  const zones = owners.map((owner, i) => ({ owner, i, zx: x0 + LOUNGE_W + i * ZONE_W + ZONE_W / 2 }));
  return { owners, R, W, D, x0, z0, zDesk0, zA, zLc, zE, zones };
}
const zoneOf = (owner) => L.zones.find((z) => z.owner === owner);

function deskSpot(owner, slot) {
  const z = zoneOf(owner);
  const col = slot % COLS, row = Math.floor(slot / COLS);
  return { x: z.zx - DX + col * DX, z: L.zDesk0 + row * DZ };
}

// lugares de descanso: 6 no sofá, 3 pufes, depois em pé
function seatSpot(owner, k) {
  const z = zoneOf(owner), zx = z.zx, zLc = L.zLc;
  const laneL = zx - 1.45, laneR = zx + 1.45;
  if (k < 6) {
    const left = k < 3, j = k % 3;
    const sz = zLc - 1.05 + j * 1.05;
    return { pos: V(left ? zx - 2.68 : zx + 2.68, sz), rot: left ? Math.PI / 2 : -Math.PI / 2, y: -0.06,
             exit: [V(left ? laneL : laneR, sz)], lane: left ? laneL : laneR };
  }
  if (k < 9) {
    const px = zx + (k - 7) * 0.75, pz = zLc + 2.0;
    const lane = px <= zx ? laneL : laneR;
    return { pos: V(px, pz), rot: 0, y: -0.3, exit: [V(px, zLc + 1.35), V(lane, zLc + 1.35)], lane };
  }
  const m = k - 9, sx = zx - 5.2 + (m % 10) * 1.15, sz = L.zE - 0.55 - Math.floor(m / 10) * 0.9;
  const lane = sx <= zx ? laneL : laneR;
  return { pos: V(sx, sz), rot: 0, y: Y_STAND, exit: [V(sx, zLc + 2.9), V(lane, zLc + 2.9)], lane };
}

// caminho sofá -> mesa, desviando das mesas pelos corredores entre colunas
function buildRoute(a) {
  const seat = seatSpot(a.owner, a.seat), d = deskSpot(a.owner, a.slot);
  const aisleX = d.x + DX / 2, chairZ = d.z - 0.15;
  const pts = [seat.pos, ...seat.exit, V(seat.lane, L.zA), V(aisleX, L.zA), V(aisleX, chairZ), V(d.x, chairZ)];
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
  return { pts, lens, total: lens[lens.length - 1], seat, version: L.version };
}

function pointAt(route, s) {
  const { pts, lens } = route;
  if (s <= 0) return { p: pts[0].clone(), dir: pts[1].clone().sub(pts[0]) };
  for (let i = 1; i < pts.length; i++) {
    if (s <= lens[i] || i === pts.length - 1) {
      const t = Math.min(1, (s - lens[i - 1]) / Math.max(1e-6, lens[i] - lens[i - 1]));
      return { p: pts[i - 1].clone().lerp(pts[i], t), dir: pts[i].clone().sub(pts[i - 1]) };
    }
  }
}

// ------------------------------------------------------------ sala
let room = null, roomKey = '';
let clockTex = null, clockCtx = null;

function buildRoom() {
  const owners = ownerOrder();
  const nextL = computeLayout(owners);
  const key = owners.map((o) => o + profileOf(o).cor).join('|') + ':' + nextL.R;
  if (key === roomKey) return false;
  roomKey = key;
  nextL.version = (L?.version || 0) + 1; // caminhos feitos em outra versão precisam ser refeitos
  L = nextL;
  if (room) { scene.remove(room); room.traverse((o) => { if (o.element) o.element.remove(); }); }
  room = new THREE.Group();
  scene.add(room);
  const { W, D, x0, z0, zLc, zE } = L;

  const floor = rbox(W, 0.4, D, 0.08, mat(0x3b2c22, { roughness: 0.9 }));
  floor.position.set(0, -0.2, 0); room.add(floor);
  const wallM = mat(0x241c17, { roughness: 0.95 });
  const back = rbox(W, 4.2, 0.35, 0.05, wallM); back.position.set(0, 2.1, z0 - 0.17); room.add(back);
  const left = rbox(0.35, 4.2, D, 0.05, wallM); left.position.set(x0 - 0.17, 2.1, 0); room.add(left);
  const trim = mat(0x4a382c);
  const t1 = rbox(W, 0.18, 0.4, 0.05, trim); t1.position.set(0, 0.09, z0 - 0.05); room.add(t1);
  const t2 = rbox(0.4, 0.18, D, 0.05, trim); t2.position.set(x0 - 0.05, 0.09, 0); room.add(t2);

  // janelas (o vidro muda com a hora do dia)
  for (let i = 0; i < 3; i++) {
    const wz = z0 + 2.6 + i * 3.4;
    if (wz > z0 + D - 2) break;
    const frame = rbox(0.12, 1.9, 2.4, 0.04, mat(0xd9cbbb)); frame.position.set(x0 + 0.03, 2.3, wz); room.add(frame);
    const pane = rbox(0.1, 1.65, 2.15, 0.02, glassMat); pane.position.set(x0 + 0.07, 2.3, wz); room.add(pane);
    const bar = rbox(0.12, 0.08, 2.15, 0.02, mat(0xd9cbbb)); bar.position.set(x0 + 0.1, 2.3, wz); room.add(bar);
  }

  // placa
  const sign = rbox(5.2, 1.2, 0.12, 0.08, mat(0x120e0b, { roughness: 0.4 }));
  sign.position.set(x0 + LOUNGE_W + 3.4, 2.9, z0 + 0.05); room.add(sign);
  const signFace = new THREE.Mesh(new THREE.PlaneGeometry(5, 1.15), new THREE.MeshBasicMaterial({ map: makeTextTexture('ESCRITÓRIO IA', 'sessões ao vivo', 1024, 236), transparent: true }));
  signFace.position.set(x0 + LOUNGE_W + 3.4, 2.9, z0 + 0.12); room.add(signFace);

  // relógio de verdade
  const clockCanvas = document.createElement('canvas'); clockCanvas.width = clockCanvas.height = 256;
  clockCtx = clockCanvas.getContext('2d');
  clockTex = new THREE.CanvasTexture(clockCanvas); clockTex.colorSpace = THREE.SRGBColorSpace;
  const clock = new THREE.Mesh(new THREE.CircleGeometry(0.62, 48), new THREE.MeshBasicMaterial({ map: clockTex }));
  clock.position.set(W / 2 - 2.2, 2.9, z0 + 0.06); room.add(clock);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.64, 0.06, 12, 48), mat(0x2b2b2b, { metalness: 0.4, roughness: 0.4 }));
  rim.position.copy(clock.position); room.add(rim);
  drawClock();

  // faixa da esquerda: bebedouro, plantas, estante
  const cooler = new THREE.Group();
  const cb = rbox(0.6, 1.1, 0.6, 0.08, mat(0xe8e4dd)); cb.position.y = 0.55; cooler.add(cb);
  const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.55, 24), mat(0x8ec5e8, { transparent: true, opacity: 0.75, roughness: 0.1 }));
  bottle.position.y = 1.38; cooler.add(bottle);
  cooler.position.set(x0 + 1.0, 0, z0 + 0.9); room.add(cooler);
  const shelf = new THREE.Group();
  const sh = rbox(0.5, 2.0, 1.8, 0.05, mat(0x5f412c)); sh.position.y = 1.0; shelf.add(sh);
  const bookColors = [0xb5643c, 0x34465e, 0xd6a93a, 0x4f8a4a, 0x8a5f3f];
  for (let r = 0; r < 3; r++) for (let b = 0; b < 5; b++) {
    const book = rbox(0.32, 0.38, 0.22, 0.02, mat(bookColors[(r + b) % 5]));
    book.position.set(0.12, 0.35 + r * 0.6, -0.6 + b * 0.3); shelf.add(book);
  }
  shelf.position.set(x0 + 0.35, 0, zLc); room.add(shelf);
  addPlant(x0 + 2.2, z0 + 0.8, 1.2);
  addPlant(W / 2 - 0.9, z0 + 0.9, 1.0);
  addPlant(x0 + 0.9, zE - 0.6, 0.9);
  addPlant(W / 2 - 0.9, zE - 0.6, 1.1);

  // alas
  for (const z of L.zones) {
    const { zx, i, owner } = z;
    const prof = profileOf(owner);
    // com cor escolhida, o carpete da ala puxa pra ela
    const tint = prof.custom ? new THREE.Color(prof.cor).lerp(new THREE.Color(0x2a221c), 0.62) : new THREE.Color(ZONE_TINT[i % ZONE_TINT.length]);
    const carpet = rbox(ZONE_W - 0.8, 0.04, L.zA - z0 - 1.0, 0.05, mat(tint, { roughness: 1 }));
    carpet.position.set(zx, 0.02, (z0 + 1.6 + L.zA - 0.6) / 2 + 0.2); room.add(carpet);
    // área de descanso
    const rug = rbox(7.8, 0.04, 5.2, 0.2, mat(tint.clone().multiplyScalar(1.25), { roughness: 1 }));
    rug.position.set(zx, 0.025, zLc + 0.45); room.add(rug);
    room.add(makeSofa(zx - 2.85, zLc, Math.PI / 2));
    room.add(makeSofa(zx + 2.85, zLc, -Math.PI / 2));
    const table = rbox(1.0, 0.12, 1.7, 0.05, mat(0x8a6446)); table.position.set(zx, 0.5, zLc); room.add(table);
    const tleg = rbox(0.8, 0.44, 1.4, 0.04, mat(0x5f412c)); tleg.position.set(zx, 0.24, zLc); room.add(tleg);
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.16, 16), mat(0xf0e4d4)); mug.position.set(zx + 0.2, 0.64, zLc - 0.4); room.add(mug);
    const mag = rbox(0.4, 0.02, 0.3, 0.005, mat(0xd6a93a)); mag.position.set(zx - 0.15, 0.57, zLc + 0.35); mag.rotation.y = 0.4; room.add(mag);
    for (let k = -1; k <= 1; k++) {
      const pouf = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.42, 24), mat(k === 0 ? 0x6b4a3a : 0x34465e, { roughness: 0.95 }));
      pouf.position.set(zx + k * 0.75, 0.21, zLc + 2.0); pouf.castShadow = true; pouf.receiveShadow = true; room.add(pouf);
    }
    const el = document.createElement('div');
    el.className = 'zone-name';
    el.style.color = prof.custom ? prof.cor : '';
    el.innerHTML = `${esc(owner)}<small>${owner === me ? 'você' : 'na rede'}</small>`;
    label(el, room, new THREE.Vector3(zx, 0.1, zE + 0.1));
    if (i > 0) {
      const div = rbox(0.12, 1.1, L.zA - z0 - 1.6, 0.05, mat(0x4a382c));
      div.position.set(zx - ZONE_W / 2, 0.55, (z0 + 1.6 + L.zA) / 2 - 0.3); room.add(div);
    }
  }
  fitCamera();
  return true;
}

function makeSofa(x, z, rot) {
  const sofaM = mat(0x34465e, { roughness: 0.9 });
  const g = new THREE.Group();
  const seat = rbox(3.3, 0.45, 1.1, 0.2, sofaM); seat.position.set(0, 0.32, 0.05); g.add(seat);
  const back = rbox(3.3, 0.95, 0.32, 0.16, sofaM); back.position.set(0, 0.75, -0.45); g.add(back);
  for (const s of [-1, 1]) { const arm = rbox(0.32, 0.68, 1.1, 0.14, sofaM); arm.position.set(s * 1.65, 0.5, 0.05); g.add(arm); }
  for (const s of [-1.05, 0, 1.05]) { const c = rbox(1.0, 0.12, 0.95, 0.06, mat(0x3d5170, { roughness: 0.95 })); c.position.set(s, 0.58, 0.08); g.add(c); }
  g.position.set(x, 0, z); g.rotation.y = rot;
  return g;
}

function addPlant(x, z, s) {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.24, 0.55, 20), mat(0xb5643c));
  pot.position.y = 0.27; pot.castShadow = true; g.add(pot);
  const leafM = mat(0x4f8a4a, { roughness: 0.85 });
  for (let i = 0; i < 6; i++) {
    const leaf = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.55, 6, 10), leafM);
    leaf.position.set(Math.cos(i) * 0.12, 0.85 + (i % 3) * 0.12, Math.sin(i) * 0.12);
    leaf.rotation.set(Math.sin(i * 2) * 0.5, i, Math.cos(i * 1.7) * 0.5);
    leaf.castShadow = true; g.add(leaf);
  }
  g.scale.setScalar(s); g.position.set(x, 0, z);
  room.add(g);
}

function makeTextTexture(title, sub, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#f2e9df'; x.textAlign = 'center';
  x.font = '700 92px Inter, system-ui, sans-serif'; x.fillText(title, w / 2, h * 0.55);
  x.fillStyle = '#a8998a'; x.font = '500 38px Inter, system-ui, sans-serif'; x.fillText(sub.toUpperCase(), w / 2, h * 0.86);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function drawClock() {
  if (!clockCtx) return;
  const x = clockCtx, r = 128, d = new Date();
  x.fillStyle = '#f4efe7'; x.fillRect(0, 0, 256, 256);
  x.save(); x.translate(r, r);
  x.strokeStyle = '#2b2b2b';
  for (let i = 0; i < 12; i++) { x.save(); x.rotate((i / 12) * Math.PI * 2); x.lineWidth = 6; x.beginPath(); x.moveTo(0, -100); x.lineTo(0, -82); x.stroke(); x.restore(); }
  const hand = (a, len, wdt) => { x.save(); x.rotate(a); x.lineWidth = wdt; x.lineCap = 'round'; x.beginPath(); x.moveTo(0, 12); x.lineTo(0, -len); x.stroke(); x.restore(); };
  hand(((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2, 55, 10);
  hand((d.getMinutes() / 60) * Math.PI * 2, 85, 7);
  x.restore();
  clockTex.needsUpdate = true;
}

function fitCamera() {
  // enquadra as alas (a faixa decorativa da esquerda pode ficar meio cortada)
  const zonesW = L.zones.length * ZONE_W;
  const cx = L.x0 + LOUNGE_W + zonesW / 2;
  const aspect = innerWidth / innerHeight;
  const span = zonesW + L.D;
  // celular em pé: aproxima mais (as pontas podem ficar de fora; dá pra arrastar com dois dedos)
  const halfW = span * (aspect < 0.8 ? 0.27 : 0.37) + 0.5;
  const halfH = Math.max(halfW / aspect, span * 0.21 + 1.5);
  camera.left = -halfH * aspect; camera.right = halfH * aspect;
  camera.top = halfH; camera.bottom = -halfH;
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  const target = new THREE.Vector3(cx, 0, (L.z0 + L.zE) / 2 + 0.5);
  camera.position.copy(target).add(new THREE.Vector3(22, 20, 22));
  controls.target.copy(target);
  controls.update();
}

// ------------------------------------------------------------ dia e noite
// 0 = noite, 1 = dia; manhã das 6h às 8h e fim de tarde das 18h às 20h
function daylight(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 6 || h >= 20) return 0;
  if (h < 8) return (h - 6) / 2;
  if (h >= 18) return 1 - (h - 18) / 2;
  return 1;
}
const SUN_DAY = new THREE.Color(0xffe2c0), SUN_NIGHT = new THREE.Color(0x8fa6ff);
const GLASS_DAY = new THREE.Color(0x6d93b8), GLASS_NIGHT = new THREE.Color(0x141d33);
let lastWork = Date.now();
const light = { day: daylight(), asleep: 0 };
function updateLighting(dt) {
  const target = daylight();
  const asleep = Date.now() - lastWork > SLEEP_AFTER_MS ? 1 : 0;
  light.day += (target - light.day) * Math.min(1, dt * 0.5);
  light.asleep += (asleep - light.asleep) * Math.min(1, dt * 0.5);
  const k = 1 - light.asleep * 0.35;
  hemi.intensity = (0.38 + 0.52 * light.day) * k;
  sun.intensity = (0.45 + 1.15 * light.day) * k;
  sun.color.copy(SUN_NIGHT).lerp(SUN_DAY, light.day);
  glassMat.emissive.copy(GLASS_NIGHT).lerp(GLASS_DAY, light.day);
  glassMat.emissiveIntensity = 0.25 + 0.3 * light.day;
  scene.background.copy(BG_NIGHT).lerp(BG_DAY, light.day);
}

// ------------------------------------------------------------ mesas e bonecos
const desks = new Map();         // "owner#slot" -> grupo da mesa
const agents = new Map();        // session id -> agente
window.__escritorio = { agents };  // depuração pelo console do navegador
const slotsByOwner = new Map();  // owner -> [session id | null] (mesa)
const seatsByOwner = new Map();  // owner -> [session id | null] (lugar de descanso)

function makeDesk() {
  const g = new THREE.Group();
  const wood = mat(0x8a5f3f, { roughness: 0.7 });
  const top = rbox(2.5, 0.12, 1.15, 0.04, wood); top.position.set(0, 0.95, 0.75); g.add(top);
  for (const sx of [-1.12, 1.12]) {
    const side = rbox(0.1, 0.92, 1.05, 0.03, mat(0x5f412c)); side.position.set(sx, 0.46, 0.75); g.add(side);
  }
  const lapBase = rbox(0.95, 0.04, 0.65, 0.02, mat(0x3a3d44, { metalness: 0.4, roughness: 0.4 }));
  lapBase.position.set(0, 1.03, 0.62); g.add(lapBase);
  const lid = new THREE.Group(); lid.position.set(0, 1.05, 0.95); lid.rotation.x = -0.25; g.add(lid);
  const lidMesh = rbox(0.95, 0.65, 0.04, 0.02, mat(0x3a3d44, { metalness: 0.4, roughness: 0.4 }));
  lidMesh.position.y = 0.32; lid.add(lidMesh);
  const logo = new THREE.Mesh(new THREE.CircleGeometry(0.09, 24), new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x000000 }));
  logo.position.set(0, 0.34, 0.025); lid.add(logo);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.56), new THREE.MeshStandardMaterial({ color: 0x0e1014, emissive: 0x000000 }));
  screen.position.set(0, 0.32, -0.025); screen.rotation.y = Math.PI; lid.add(screen);
  const glow = new THREE.PointLight(0xffffff, 0, 2.6, 2); glow.position.set(0, 1.5, 0.5); g.add(glow);
  // halo no chão: aparece quando alguém trabalha aqui
  const halo = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.55, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  halo.rotation.x = -Math.PI / 2; halo.position.set(0, 0.06, 0.35); g.add(halo);
  const oil = makeOilCan(); oil.position.set(0.85, 1.01, 0.5); g.add(oil);
  const paper = rbox(0.4, 0.02, 0.3, 0.005, mat(0xeee7dc)); paper.position.set(-0.85, 1.02, 0.7); paper.rotation.y = 0.3; g.add(paper);
  const chairM = mat(0x2c2e33, { roughness: 0.6 });
  const seat = rbox(0.85, 0.14, 0.8, 0.06, chairM); seat.position.set(0, 0.55, -0.15); g.add(seat);
  const back = rbox(0.85, 0.9, 0.12, 0.06, chairM); back.position.set(0, 1.05, -0.58); g.add(back);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.45, 10), mat(0x777777, { metalness: 0.6 })); pole.position.set(0, 0.27, -0.15); g.add(pole);
  g.userData = { logo, screen, glow, halo, oil, oilHome: oil.position.clone() };
  return g;
}

// lata de óleo de máquina (a "bebida" dos bonecos). Origem na base; o bico aponta pro lado do boneco (-x)
function makeOilCan() {
  const g = new THREE.Group();
  const metal = mat(0xb8402e, { roughness: 0.35, metalness: 0.55 });
  const band = mat(0xf2c14e, { roughness: 0.4, metalness: 0.3 });
  const steel = mat(0x9a9ea6, { roughness: 0.3, metalness: 0.8 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, 0.2, 20), metal); body.position.y = 0.1; g.add(body);
  const label = new THREE.Mesh(new THREE.CylinderGeometry(0.104, 0.112, 0.07, 20), band); label.position.y = 0.1; g.add(label);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.1, 0.08, 20), metal); top.position.y = 0.24; g.add(top);
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.017, 0.24, 8), steel);
  spout.position.set(-0.08, 0.34, 0); spout.rotation.z = 0.75; g.add(spout);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 16, Math.PI), steel);
  handle.position.set(0.1, 0.13, 0); handle.rotation.z = -Math.PI / 2; g.add(handle);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function makeBot(source) {
  const color = new THREE.Color(SRC[source]?.color ?? 0xaaaaaa);
  const lightC = color.clone().lerp(new THREE.Color(0xffffff), 0.18);
  const bodyM = mat(color.clone(), { roughness: 0.55 });
  const headM = mat(lightC.clone(), { roughness: 0.5 });
  const g = new THREE.Group();
  const inner = new THREE.Group(); g.add(inner); // inner balança/pula; g anda e gira
  const body = rbox(0.9, 0.7, 0.7, 0.22, bodyM); body.position.y = 1.0; inner.add(body);
  const head = new THREE.Group(); head.position.y = 1.72; inner.add(head);
  const skull = rbox(1.05, 0.82, 0.86, 0.26, headM); head.add(skull);
  const face = rbox(0.78, 0.5, 0.06, 0.12, mat(0x15171c, { roughness: 0.3 })); face.position.set(0, -0.02, 0.43); head.add(face);
  const eyeM = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color.clone().lerp(new THREE.Color(0xffffff), 0.6), emissiveIntensity: 1.2 });
  const eyes = [];
  for (const sx of [-0.17, 0.17]) {
    const e = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.08, 4, 10), eyeM);
    e.position.set(sx, -0.01, 0.47); head.add(e); eyes.push(e);
  }
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 8), mat(0x555555, { metalness: 0.5 }));
  stalk.position.y = 0.55; head.add(stalk);
  const tipM = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 });
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), tipM); tip.position.y = 0.72; head.add(tip);
  const arms = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group(); pivot.position.set(s * 0.5, 1.2, 0.05); inner.add(pivot);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.35, 4, 10), bodyM);
    arm.position.y = -0.25; pivot.add(arm);
    pivot.rotation.x = -0.5;
    arms.push(pivot);
  }
  const feet = [];
  for (const s of [-1, 1]) {
    const f = rbox(0.24, 0.14, 0.34, 0.06, mat(color.clone().multiplyScalar(0.6), { roughness: 0.6 }));
    f.position.set(s * 0.22, 0.58, 0.05); inner.add(f); feet.push(f);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, inner, head, eyes, tipM, arms, feet, bodyM, headM, stalk, tip,
    base: { body: color.clone(), head: lightC.clone(), tip: color.clone() }, acc: null, accKey: '' };
}

// acessório da pessoa na cabeça do boneco
function setAccessory(bot, prof) {
  const key = prof.acessorio + prof.cor;
  if (bot.accKey === key) return;
  bot.accKey = key;
  if (bot.acc) { bot.head.remove(bot.acc); bot.acc = null; }
  const showAntenna = !['bone', 'coroa', 'fones'].includes(prof.acessorio);
  bot.stalk.visible = bot.tip.visible = showAntenna;
  if (prof.acessorio === 'nenhum') return;
  const c = new THREE.Color(prof.cor);
  const m = mat(c, { roughness: 0.5 });
  const g = new THREE.Group();
  if (prof.acessorio === 'bone') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), m);
    cap.scale.set(1.08, 0.5, 0.92); cap.position.y = 0.4; g.add(cap);
    const brim = rbox(0.78, 0.05, 0.42, 0.02, m); brim.position.set(0, 0.42, 0.52); g.add(brim);
    const btn = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), m); btn.position.y = 0.66; g.add(btn);
  } else if (prof.acessorio === 'oculos') {
    const fm = mat(c.clone().multiplyScalar(0.7), { roughness: 0.3, metalness: 0.3 });
    for (const sx of [-0.17, 0.17]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.025, 8, 24), fm); ring.position.set(sx, -0.01, 0.5); g.add(ring);
    }
    const bridge = rbox(0.13, 0.03, 0.03, 0.01, fm); bridge.position.set(0, 0.01, 0.5); g.add(bridge);
  } else if (prof.acessorio === 'laco') {
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.26, 16), m);
      wing.rotation.z = s * Math.PI / 2; wing.position.set(0.32 + s * 0.15, 0.48, 0); g.add(wing);
    }
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), m); knot.position.set(0.32, 0.48, 0); g.add(knot);
    g.rotation.z = -0.25;
  } else if (prof.acessorio === 'fones') {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.045, 8, 32, Math.PI), m); band.position.y = 0.0; g.add(band);
    for (const s of [-1, 1]) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 20), m);
      cup.rotation.z = Math.PI / 2; cup.position.set(s * 0.58, -0.02, 0); g.add(cup);
    }
  } else if (prof.acessorio === 'coroa') {
    const gold = mat(c.clone().lerp(new THREE.Color(0xffd34d), 0.55), { roughness: 0.25, metalness: 0.6 });
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.34, 0.16, 24, 1, true), gold); ring.position.y = 0.5; g.add(ring);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.18, 8), gold);
      spike.position.set(Math.cos(a) * 0.31, 0.66, Math.sin(a) * 0.31); g.add(spike);
    }
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  bot.head.add(g);
  bot.acc = g;
}

function srcName(s) { return SRC[s]?.name || s; }
const isWorking = (s) => s?.state === 'thinking' || s?.state === 'tool' || s?.state === 'waiting';

function take(map, owner, id) {
  if (!map.has(owner)) map.set(owner, []);
  const arr = map.get(owner);
  let i = arr.indexOf(null);
  if (i < 0) { i = arr.length; arr.push(id); } else arr[i] = id;
  return i;
}

function tagFor(group, id) { group.traverse((o) => { o.userData.agentId = id; }); }

function ensureAgent(s) {
  let a = agents.get(s.id);
  if (a && a.source !== s.source) { removeAgent(s.id); a = null; }
  if (a) return a;
  const owner = s.owner || '?';
  const slot = take(slotsByOwner, owner, s.id);
  const seat = take(seatsByOwner, owner, s.id);
  buildRoom();

  const deskKey = owner + '#' + slot;
  let desk = desks.get(deskKey);
  if (!desk) { desk = makeDesk(); desks.set(deskKey, desk); scene.add(desk); }
  const d = deskSpot(owner, slot); desk.position.set(d.x, 0, d.z);
  tagFor(desk, s.id);

  const bot = makeBot(s.source);
  setAccessory(bot, profileOf(owner));
  tagFor(bot.group, s.id);
  scene.add(bot.group);
  const tagEl = document.createElement('div'); tagEl.className = 'tag';
  tagEl.addEventListener('click', () => ui.openDetail(s.id));
  const tag = label(tagEl, desk, new THREE.Vector3(0, 0.2, 1.55));
  const bubEl = document.createElement('div'); bubEl.className = 'bubble hide';
  const bub = label(bubEl, bot.group, new THREE.Vector3(0, 2.8, 0));
  const zzEl = document.createElement('div'); zzEl.className = 'zz hide'; zzEl.innerHTML = '<span>z</span><span>z</span>';
  const zz = label(zzEl, bot.group, new THREE.Vector3(0.45, 2.45, 0));

  a = { id: s.id, owner, slot, seat, source: s.source, desk, bot, tagEl, tag, bubEl, bub, zzEl, zz,
        born: performance.now(), s: 0, dir: 0, hopAt: -1e9, bubbleUntil: 0, bubbleKind: '',
        promptUntil: 0, doneQueued: null, leaveAt: 0, arrivedAt: 0, session: s, helpers: new Map(), focusUntil: 0 };
  a.route = buildRoute(a);
  a.s = isWorking(s) ? a.route.total : 0; // no carregamento já aparece no lugar certo, sem andar
  agents.set(s.id, a);
  return a;
}

function removeAgent(id) {
  const a = agents.get(id); if (!a) return;
  scene.remove(a.bot.group);
  for (const h of a.helpers.values()) scene.remove(h.bot.group);
  for (const el of [a.tagEl, a.bubEl, a.zzEl]) el.remove();
  a.desk.remove(a.tag);
  tagFor(a.desk, null);
  const sl = slotsByOwner.get(a.owner); if (sl) sl[a.slot] = null;
  const se = seatsByOwner.get(a.owner); if (se) se[a.seat] = null;
  setDeskLight(a.desk, null, 0);
  a.desk.userData.halo.material.opacity = 0;
  agents.delete(id);
}

// ajudantes (subagentes): bonequinhos menores em volta da mesa
function syncHelpers(a, list = []) {
  const want = new Set(list.slice(0, HELPER_SPOTS.length).map((h) => h.id));
  for (const [id, h] of a.helpers) if (!want.has(id) && !h.leaving) h.leaving = performance.now();
  list.slice(0, HELPER_SPOTS.length).forEach((h) => {
    if (a.helpers.has(h.id) && !a.helpers.get(h.id).leaving) return;
    const used = new Set([...a.helpers.values()].filter((x) => !x.leaving).map((x) => x.spot));
    const spot = HELPER_SPOTS.findIndex((_, i) => !used.has(i));
    if (spot < 0) return;
    const bot = makeBot(a.source);
    bot.group.scale.setScalar(0.001);
    tagFor(bot.group, a.id);
    scene.add(bot.group);
    a.helpers.set(h.id, { bot, spot, born: performance.now(), leaving: 0, seed: Math.random() * 10 });
  });
}

function setDeskLight(desk, color, level) {
  const { logo, screen, glow } = desk.userData;
  const c = new THREE.Color(color ?? 0x000000);
  logo.material.emissive.copy(c); logo.material.emissiveIntensity = level * 1.5;
  screen.material.emissive.copy(c.clone().lerp(new THREE.Color(0xffffff), 0.5)); screen.material.emissiveIntensity = level;
  glow.color.copy(c); glow.intensity = level * 4;
}

function showBubble(a, kind, lbl, text, ms) {
  a.bubbleKind = kind;
  a.bubEl.className = 'bubble ' + kind;
  a.bubEl.innerHTML = (lbl ? `<span class="lbl">${esc(lbl)}</span>` : '') + esc(text);
  a.bubbleUntil = ms ? performance.now() + ms : Infinity;
}
function workBubble(a) {
  const s = a.session;
  if (s.state === 'waiting') showBubble(a, 'wait', 'precisa de você', '✋ ' + (s.waitingFor || 'esperando você'), 0);
  else if (s.state === 'tool' && s.lastTool) showBubble(a, 'tool', '', '⚙ ' + s.lastTool, 0);
  else showBubble(a, 'think', '', 'pensando…', 0);
}

function renderTag(a) {
  const s = a.session;
  const title = s.title || s.project || srcName(s.source);
  const n = (s.helpers || []).length;
  a.tagEl.innerHTML = `<i class="src" style="background:${SRC[s.source]?.css || '#aaa'}"></i>${esc(title)}` +
    (s.project && s.title ? ` <span class="proj">· ${esc(s.project)}</span>` : '') +
    (n ? ` <span class="hl">· ${n} ${n === 1 ? 'ajudante' : 'ajudantes'}</span>` : '');
  a.tagEl.title = `${srcName(s.source)} · ${s.owner} (clique pra ver detalhes)`;
}

function applySession(s, ev) {
  const a = ensureAgent(s);
  a.session = s;
  renderTag(a);
  syncHelpers(a, s.helpers);
  if (isWorking(s)) lastWork = Date.now();
  const now = performance.now();

  if (ev?.type === 'prompt') {
    showBubble(a, '', `${s.owner} pediu`, ev.text || '…', 9000);
    a.promptUntil = now + MIN_PROMPT_MS;
    a.doneQueued = null; a.leaveAt = 0;
  } else if (ev?.type === 'waiting') {
    workBubble(a); // mais importante que o balão do pedido: aparece na hora
  } else if (ev?.type === 'tool') {
    if (now > a.promptUntil) workBubble(a);
  } else if (ev?.type === 'done') {
    a.doneQueued = ev.text || ''; // mostra quando ele estiver na mesa e o pedido já tiver sido lido
  } else if (!ev) {
    if (isWorking(s)) { if (now > a.promptUntil || s.state === 'waiting') workBubble(a); }
    else if (a.bubbleKind !== 'done') a.bubEl.classList.add('hide');
  }
}

// clique num boneco ou mesa abre o detalhe; o painel também pode pedir pra destacar um boneco
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const targets = [];
  for (const a of agents.values()) { targets.push(a.bot.group, a.desk); for (const h of a.helpers.values()) targets.push(h.bot.group); }
  const hit = ray.intersectObjects(targets, true).find((h) => h.object.userData.agentId);
  if (hit) { focusAgent(hit.object.userData.agentId); ui.openDetail(hit.object.userData.agentId); }
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const targets = [...agents.values()].map((a) => a.bot.group);
  renderer.domElement.style.cursor = ray.intersectObjects(targets, true).length ? 'pointer' : '';
});
function focusAgent(id) { const a = agents.get(id); if (a) a.focusUntil = performance.now() + 1600; }

// ------------------------------------------------------------ dados
function renderOwners() {
  document.getElementById('owners').innerHTML = ownerInfo
    .map((o) => `<span class="owner-chip ${o.online ? '' : 'off'}"><i class="dot" style="background:${esc(profileOf(o.owner).cor)}"></i>${esc(o.owner)}${o.self ? ' (você)' : o.online ? '' : ' · offline'}</span>`).join('');
}

function handle(msg) {
  if (msg.kind === 'owners') {
    if (msg.me) me = msg.me;
    // o coletor foi atualizado: recarrega a página pra pegar os arquivos novos
    if (msg.version !== undefined) {
      if (pageVersion === null) pageVersion = msg.version;
      else if (msg.version !== pageVersion) return location.reload();
    }
    ownerInfo = msg.owners; renderOwners();
    for (const a of agents.values()) {
      const prof = profileOf(a.owner);
      setAccessory(a.bot, prof);
      for (const h of a.helpers.values()) setAccessory(h.bot, prof);
    }
    ui.setOwners(ownerInfo, msg.me, msg.local);
    updateSub();
  } else if (msg.kind === 'snapshot') {
    for (const id of [...agents.keys()]) if (!msg.sessions.find((s) => s.id === id)) { removeAgent(id); ui.remove(id); }
    msg.sessions.sort((x, y) => x.createdAt - y.createdAt).forEach((s) => { applySession(s, null); ui.session(s, null); });
  } else if (msg.kind === 'session') {
    applySession(msg.session, msg.event);
    ui.session(msg.session, msg.event);
  } else if (msg.kind === 'remove') {
    removeAgent(msg.id);
    ui.remove(msg.id);
  } else if (msg.kind === 'stats') {
    ui.stats(msg.owner, msg.stats);
  } else if (msg.kind === 'health') {
    ui.health(msg);
  }
  relayout();
}

function updateSub() {
  const n = ownerInfo.length;
  const asleep = Date.now() - lastWork > SLEEP_AFTER_MS;
  document.getElementById('sub').textContent = (n > 1 ? `${n} pessoas na rede` : 'só você na rede, por enquanto') + (asleep ? ' · escritório dormindo' : '');
}

function relayout() {
  buildRoom();
  for (const a of agents.values()) {
    const d = deskSpot(a.owner, a.slot);
    a.desk.position.set(d.x, 0, d.z);
    if (!a.route || a.route.version !== L.version) {
      const ratio = a.route ? a.s / a.route.total : 0;
      a.route = buildRoute(a);
      a.s = ratio * a.route.total;
    }
  }
}

const liveEl = document.getElementById('live');
if (new URLSearchParams(location.search).has('demo')) {
  startDemo();
} else {
  const es = new EventSource('/events');
  es.onopen = () => { liveEl.textContent = '● ao vivo'; liveEl.style.color = 'var(--ok)'; };
  es.onerror = () => { liveEl.textContent = '● reconectando…'; liveEl.style.color = 'var(--muted)'; };
  es.onmessage = (e) => handle(JSON.parse(e.data));
}

function startDemo() {
  liveEl.textContent = '● demonstração';
  me = 'Ana';
  handle({ kind: 'owners', me, owners: [{ owner: 'Ana', self: true, online: true, cor: '#e07a52', acessorio: 'fones' }, { owner: 'Bia', online: true, cor: '#c86fb4', acessorio: 'laco' }] });
  const t0 = Date.now();
  const base = [
    { id: 'd1', owner: 'Ana', source: 'desktop', title: 'Escritório IA', project: 'escritorio' },
    { id: 'd2', owner: 'Ana', source: 'sdk', title: 'Relatório de vendas', project: 'relatorios' },
    { id: 'd3', owner: 'Ana', source: 'antigravity', title: 'Limpar cache de rede' },
    { id: 'd6', owner: 'Ana', source: 'terminal', title: 'deploy', project: 'site' },
    { id: 'd4', owner: 'Bia', source: 'desktop', title: 'Roteiro da viagem' },
    { id: 'd5', owner: 'Bia', source: 'gemini', title: 'Planilha de convidados' },
  ].map((s, i) => ({ ...s, createdAt: i, spans: [[t0 - (150 - i * 20) * 60000, t0 - (138 - i * 20) * 60000], [t0 - (60 - i * 7) * 60000, t0 - (52 - i * 7) * 60000]], tokens: { in: 12000 * (i + 1), out: 3400 * (i + 1), cache: 90000 } }));
  base.forEach((s) => handle({ kind: 'session', session: { ...s, state: 'done' } }));
  handle({ kind: 'stats', owner: 'Ana', stats: { prompts: 42, workMs: 7380000, tools: { Bash: 61, Edit: 38, Read: 25, Grep: 9 }, bySource: { desktop: 25, sdk: 9, antigravity: 5, terminal: 3 }, tokens: { in: 820000, out: 214000, cache: 9100000 } } });
  handle({ kind: 'stats', owner: 'Bia', stats: { prompts: 17, workMs: 2460000, tools: { WebSearch: 12, Read: 6 }, bySource: { desktop: 12, gemini: 5 }, tokens: { in: 160000, out: 52000, cache: 800000 } } });
  const prompts = ['Formate essa query pra eu ver melhor', 'Por que o build quebrou?', 'Resume esse PDF em 5 tópicos', 'Cria um teste pra esse endpoint', 'Qual a melhor data pro voo?'];
  const tools = ['Read', 'Bash', 'Edit', 'Grep', 'WebSearch'];
  let k = 0;
  const cycle = () => {
    const s = base[k++ % base.length];
    const now = Date.now();
    const kind = k % 4; // 0 rápido, 1 normal, 2 com ajudantes, 3 esperando você
    handle({ kind: 'session', session: { ...s, state: 'thinking', turnStart: now, lastPrompt: prompts[k % prompts.length] }, event: { type: 'prompt', text: prompts[k % prompts.length] } });
    if (kind === 0) {
      setTimeout(() => handle({ kind: 'session', session: { ...s, state: 'done' }, event: { type: 'done', text: 'feito' } }), 1200);
      return;
    }
    const helpers = kind === 2 ? [{ id: 'h1', desc: 'Procurar no código' }, { id: 'h2', desc: 'Ler a documentação' }] : [];
    setTimeout(() => handle({ kind: 'session', session: { ...s, state: 'tool', turnStart: now, lastTool: kind === 2 ? 'Agent' : tools[k % tools.length], helpers }, event: { type: 'tool', text: tools[k % tools.length] } }), 3500);
    if (kind === 3) {
      setTimeout(() => handle({ kind: 'session', session: { ...s, state: 'waiting', turnStart: now, waitingFor: 'Claude needs your permission to use Bash' }, event: { type: 'waiting', text: '' } }), 5000);
      setTimeout(() => handle({ kind: 'session', session: { ...s, state: 'tool', turnStart: now, lastTool: 'Bash' }, event: { type: 'tool', text: 'Bash' } }), 9500);
    }
    if (kind === 2) setTimeout(() => handle({ kind: 'session', session: { ...s, state: 'tool', turnStart: now, lastTool: 'Edit', helpers: helpers.slice(1) }, event: { type: 'tool', text: 'Edit' } }), 7500);
    setTimeout(() => handle({ kind: 'session', session: { ...s, state: 'done', helpers: [], spans: [...s.spans, [now, Date.now()]] }, event: { type: 'done', text: 'feito' } }), kind === 3 ? 12000 : 10000);
  };
  cycle(); setInterval(cycle, 4000);
}

// ------------------------------------------------------------ animação
const clock = new THREE.Clock();
let lastMinute = -1, lastT = 0;
const tmpColor = new THREE.Color();
const SLEEP_GRAY = new THREE.Color(0x6a625c);
const WAIT_C = new THREE.Color(WAIT);

const SIP_MS = 2800;
const smooth = (x) => { x = THREE.MathUtils.clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const SIP_LIFT = new THREE.Vector3(0.62, 1.32, 0.28);   // lata na mão, acima da mesa (coordenadas da mesa)
const SIP_MOUTH = new THREE.Vector3(0.3, 1.58, 0.66);   // lata na boca (coordenadas do boneco)
const tmpV = new THREE.Vector3();

function sip(a, programming, atDesk, now) {
  const { oil, oilHome } = a.desk.userData;
  const { arms, head } = a.bot;
  if (!a.sipAt) {
    if (!programming) { a.nextSip = 0; return; }
    if (!a.nextSip) a.nextSip = now + 3000 + Math.random() * 6000; // primeiro gole logo depois de sentar
    if (now < a.nextSip) return;
    a.sipAt = now;
  }
  const ph = (now - a.sipAt) / SIP_MS;
  if (ph >= 1 || !atDesk) {
    a.sipAt = 0;
    a.nextSip = now + 9000 + Math.random() * 9000;
    oil.position.copy(oilHome); oil.rotation.set(0, 0, 0);
    return;
  }
  // 0–.22 pega · .22–.38 leva à boca · .38–.72 bebe · .72–1 devolve
  const toHand = ph < 0.72 ? smooth(ph / 0.22) : 1 - smooth((ph - 0.72) / 0.2);
  const toMouth = ph < 0.72 ? smooth((ph - 0.22) / 0.16) : 1 - smooth((ph - 0.72) / 0.14);
  const drink = smooth((ph - 0.38) / 0.08) * (1 - smooth((ph - 0.64) / 0.08));

  a.bot.group.updateMatrixWorld();
  const mouth = a.desk.worldToLocal(a.bot.group.localToWorld(tmpV.copy(SIP_MOUTH)));
  oil.position.copy(oilHome).lerp(SIP_LIFT, toHand).lerp(mouth, toMouth);
  oil.rotation.z = drink * 1.05; // inclina o bico pra boca

  arms[1].rotation.x = THREE.MathUtils.lerp(-1.0, -1.45, toHand) + (-2.6 + 1.45) * toMouth;
  arms[1].rotation.z = 0;
  head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, -0.38 * drink, 0.3);
  head.rotation.z *= 1 - drink;
}

function tick() { frame(); requestAnimationFrame(tick); }
// depuração: avança um quadro mesmo com a aba escondida, e acesso à câmera
Object.assign(window.__escritorio, { frame: () => frame(), camera, controls, renderer });

function frame() {
  const t = clock.getElapsedTime();
  const dt = Math.min(0.05, t - lastT); lastT = t;
  const now = performance.now();
  updateLighting(dt);

  for (const a of agents.values()) {
    const { group, inner, head, eyes, tipM, arms, feet, bodyM, headM, base } = a.bot;
    const s = a.session, working = isWorking(s), waiting = s.state === 'waiting', seed = a.slot * 1.7 + a.seat * 0.9;
    const total = a.route.total;
    const atDesk = a.s >= total - 1e-3, atSeat = a.s <= 1e-3;

    // quer estar na mesa enquanto trabalha, enquanto tem "pronto" pra mostrar, ou no tempo mínimo
    const wantDesk = working || a.doneQueued !== null || now < a.leaveAt || (atDesk && now < a.arrivedAt + MIN_DESK_MS);
    const prevS = a.s;
    a.s = THREE.MathUtils.clamp(a.s + (wantDesk ? 1 : -1) * WALK_SPEED * dt, 0, total);
    const moving = a.s !== prevS;
    if (!atDesk && a.s >= total - 1e-3) a.arrivedAt = now;

    // "pronto" só depois de chegar na mesa e de o pedido ficar visível o mínimo
    if (a.s >= total - 1e-3 && a.doneQueued !== null && now >= a.promptUntil) {
      a.hopAt = now;
      showBubble(a, 'done', '', '✓ pronto' + (a.doneQueued ? ': ' + a.doneQueued.slice(0, 90) : ''), 4000);
      a.leaveAt = now + DONE_LINGER_MS;
      a.doneQueued = null;
    }

    // posição e rotação ao longo do caminho
    const { p, dir } = pointAt(a.route, a.s);
    group.position.x = p.x; group.position.z = p.z;
    const nearSeat = a.s < 0.6, nearDesk = a.s > total - 0.6;
    let y = Y_STAND, rot;
    if (nearSeat) y = THREE.MathUtils.lerp(a.route.seat.y, Y_STAND, a.s / 0.6);
    if (nearDesk) y = THREE.MathUtils.lerp(Y_CHAIR, Y_STAND, (total - a.s) / 0.6);
    if (a.s <= 1e-3) rot = a.route.seat.rot;
    else if (a.s >= total - 1e-3) rot = 0;
    else {
      const sign = moving ? Math.sign(a.s - prevS) : (wantDesk ? 1 : -1);
      rot = Math.atan2(dir.x * sign, dir.z * sign);
    }
    let dr = rot - group.rotation.y; dr = Math.atan2(Math.sin(dr), Math.cos(dr));
    group.rotation.y += dr * Math.min(1, dt * 10);

    // nascer (e um pulinho de destaque quando clicado no painel)
    const born = Math.min(1, (now - a.born) / 600);
    const focus = a.focusUntil > now ? Math.sin(((a.focusUntil - now) / 1600) * Math.PI * 4) * 0.08 : 0;
    group.scale.setScalar(Math.max(0.001, (1 - Math.pow(1 - born, 3)) * (1 + Math.sin(born * Math.PI) * 0.15) + Math.abs(focus)));

    // corpo: passinhos ao andar, pulo no "pronto", respiração
    const hop = (now - a.hopAt) / 700;
    const hopY = hop >= 0 && hop < 1 ? Math.sin(hop * Math.PI) * 0.45 : 0;
    const stepPhase = a.s * 5.5;
    const walkBob = moving ? Math.abs(Math.sin(stepPhase)) * 0.12 : 0;
    group.position.y = y + hopY + walkBob + Math.sin(t * 1.6 + seed) * 0.015;
    feet.forEach((f, i) => { f.position.z = 0.05 + (moving ? Math.sin(stepPhase + i * Math.PI) * 0.16 : 0); });
    inner.rotation.z = moving ? Math.sin(stepPhase) * 0.06 : THREE.MathUtils.lerp(inner.rotation.z, 0, 0.1);

    // olhos: sonolentos no sofá, arregalados esperando você, piscando no resto
    const sleepy = atSeat && !working;
    const blink = (t + seed) % 4 < 0.12 ? 0.15 : 1;
    eyes.forEach((e) => (e.scale.y = THREE.MathUtils.lerp(e.scale.y, sleepy ? 0.3 : waiting ? 1.35 : blink, 0.25)));

    // cor: mais apagado descansando
    const dim = sleepy ? 0.35 : 0;
    bodyM.color.copy(tmpColor.copy(base.body).lerp(SLEEP_GRAY, dim));
    headM.color.copy(tmpColor.copy(base.head).lerp(SLEEP_GRAY, dim));
    tipM.emissive.copy(waiting ? WAIT_C : base.tip);
    tipM.color.copy(waiting ? WAIT_C : base.tip);

    // pose
    const typing = atDesk && working && !waiting;
    if (atDesk && waiting) {
      // levanta a mão e acena
      arms[1].rotation.x = THREE.MathUtils.lerp(arms[1].rotation.x, -2.9, 0.15);
      arms[1].rotation.z = Math.sin(t * 9) * 0.35;
      arms[0].rotation.x = THREE.MathUtils.lerp(arms[0].rotation.x, -0.4, 0.1);
      head.rotation.x = -0.25; head.rotation.z = Math.sin(t * 4.5) * 0.1;
      inner.position.y = Math.abs(Math.sin(t * 4.5)) * 0.06;
      tipM.emissiveIntensity = Math.sin(t * 8) > 0 ? 2.6 : 0.4;
    } else if (typing && s.state === 'tool') {
      arms.forEach((pv, i) => { pv.rotation.x = -1.25 + Math.sin(t * 22 + i * Math.PI) * 0.2; pv.rotation.z = 0; });
      head.rotation.x = 0.18; head.rotation.z = Math.sin(t * 3) * 0.05;
      inner.position.y = Math.abs(Math.sin(t * 11)) * 0.03;
      tipM.emissiveIntensity = 1.5 + Math.sin(t * 12) * 0.8;
    } else if (typing) {
      arms.forEach((pv, i) => { pv.rotation.x = THREE.MathUtils.lerp(pv.rotation.x, i ? -1.9 : -1.0, 0.1); pv.rotation.z = 0; });
      head.rotation.z = Math.sin(t * 1.8) * 0.15; head.rotation.x = -0.12;
      inner.position.y = 0;
      tipM.emissiveIntensity = Math.sin(t * 5) > 0 ? 2 : 0.3;
    } else if (moving) {
      arms.forEach((pv, i) => { pv.rotation.x = -0.3 + Math.sin(stepPhase + i * Math.PI) * 0.5; pv.rotation.z = 0; });
      head.rotation.x = 0; head.rotation.z = 0; inner.position.y = 0;
      tipM.emissiveIntensity = 0.8;
    } else {
      arms.forEach((pv) => { pv.rotation.x = THREE.MathUtils.lerp(pv.rotation.x, sleepy ? -0.2 : -0.5, 0.06); pv.rotation.z = THREE.MathUtils.lerp(pv.rotation.z, 0, 0.1); });
      head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, sleepy ? 0.18 : Math.sin(t * 0.7 + seed) * 0.04, 0.05);
      head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, sleepy ? 0.15 : 0, 0.05);
      inner.position.y = 0;
      tipM.emissiveIntensity = sleepy ? 0.15 : 0.5;
    }

    // gole de óleo enquanto programa: pega a lata, leva à boca, inclina, devolve
    sip(a, typing, atDesk, now);

    // mesa: notebook e halo (âmbar piscando quando espera você)
    const col = waiting ? WAIT : SRC[a.source]?.color;
    const halo = a.desk.userData.halo.material;
    if (atDesk && working) {
      const lvl = waiting ? 0.5 + (Math.sin(t * 6) > 0 ? 0.45 : 0) : s.state === 'tool' ? 0.85 + Math.sin(t * 9 + seed) * 0.2 : 0.6;
      setDeskLight(a.desk, col, lvl);
      halo.color.setHex(col); halo.opacity = waiting ? 0.45 + Math.sin(t * 6) * 0.3 : 0.35 + Math.sin(t * 3 + seed) * 0.2;
    } else {
      setDeskLight(a.desk, col, atDesk ? 0.15 : 0);
      halo.opacity = THREE.MathUtils.lerp(halo.opacity, 0, 0.1);
    }

    // ajudantes: aparecem, digitam do lado da mesa e somem quando terminam
    for (const [hid, h] of a.helpers) {
      const hb = h.bot, [ox, oz] = HELPER_SPOTS[h.spot];
      const grow = Math.min(1, (now - h.born) / 500);
      const shrink = h.leaving ? Math.max(0, 1 - (now - h.leaving) / 400) : 1;
      if (h.leaving && shrink <= 0) { scene.remove(hb.group); a.helpers.delete(hid); continue; }
      hb.group.scale.setScalar(Math.max(0.001, 0.48 * (1 - Math.pow(1 - grow, 3)) * shrink));
      hb.group.position.set(a.desk.position.x + ox, -0.25 + Math.abs(Math.sin(t * 7 + h.seed)) * 0.05, a.desk.position.z + oz);
      hb.group.rotation.y = Math.atan2(-ox, 0.75 - oz);
      hb.arms.forEach((pv, i) => (pv.rotation.x = -1.2 + Math.sin(t * 20 + i * Math.PI + h.seed) * 0.25));
      hb.head.rotation.x = 0.15;
      hb.tipM.emissiveIntensity = Math.sin(t * 10 + h.seed) > 0 ? 2 : 0.4;
    }

    // balões e "zz"
    if (now > a.bubbleUntil) {
      if (working) workBubble(a);
      else a.bubEl.classList.add('hide');
    }
    a.zzEl.classList.toggle('hide', !(sleepy && born >= 1));
    a.tagEl.classList.toggle('away', !atDesk);
    a.tagEl.classList.toggle('wait', waiting);
  }

  const d = new Date();
  if (d.getMinutes() !== lastMinute) { lastMinute = d.getMinutes(); drawClock(); updateSub(); }
  controls.update();
  renderer.render(scene, camera);
  labels.render(scene, camera);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
  if (L) fitCamera();
}
addEventListener('resize', resize);
buildRoom();
resize();
tick();
