// First-person walk through the house model (web/house.glb, exported by tools/export_web.py).
// Blender coordinates (x, y, z; Z up) become three.js (x, z, -y).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { computeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";

// Collision and ground rays test a bounding-volume tree instead of every triangle, so
// detailed (merged) furniture stays cheap to bump into.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const EYE = 1.6;          // eye height above the feet (m)
const RADIUS = 0.3;       // body radius for wall collisions
const STEP = 0.45;        // highest step you can walk up
const WALK = 1.6, RUN = 4.0;
const GRAVITY = 9.8;
const IS_TOUCH = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Teleports in Blender coordinates: id (English name, also used in ?spot= and #links),
// Ukrainian name, position (x, y), a point to look at, and the button group.
// Keys 1-9 jump to the first nine.
const SPOTS = [
  ["Street", "Вулиця", [13.5, -6.5], [13.5, 2.0], "out"],
  ["Side yard", "Бічний двір", [14.5, 0.2], [14.0, 10.0], "out"],
  ["Well", "Криниця", [14.0, 13.0], [12.0, 15.6], "out"],
  ["Back garden", "Город", [12.3, 26.6], [11.0, 9.6], "out"],
  ["Toilet path", "Стежка до вбиральні", [15.9, 17.7], [21.7, 33.4], "out"],
  ["Entrance", "Вхід", [12.0, 10.6], [12.0, 8.0], "out"],
  ["Bedroom", "Спальня", [2.75, 3.5], [2.75, 0.4], "house"],
  ["Kids room", "Дитяча", [6.42, 3.5], [6.42, 0.4], "house"],
  ["Hall", "Зала", [2.75, 4.4], [1.2, 8.6], "house"],
  ["Hall #2", "Зала №2", [6.45, 4.5], [6.6, 9.0], "house"],
  ["Bathroom", "Ванна", [9.0, 8.35], [10.6, 8.3], "house"],
  ["Kitchen", "Кухня", [9.45, 4.5], [9.5, 0.6], "house"],
  ["Hallway", "Коридор", [8.9, 5.8], [10.6, 6.2], "house"],
  ["Extension room", "Прибудова", [11.3, 5.6], [12.8, 6.0], "house"],
  ["Stairs", "Сходи", [11.9, 7.3], [11.8, 9.0], "house"],
  ["Cellar", "Погріб", [11.8, 10.2], [8.5, 10.2], "house"],
  ["Workshop", "Майстерня", [16.8, 5.4], [19.4, 6.8], "bld"],
  ["Garage", "Гараж", [16.8, 4.0], [18.3, 0.0], "bld"],
  ["Bath house", "Лазня", [18.9, 12.4], [21.8, 12.6], "bld"],
  ["Toilet", "Вбиральня", [21.98, 32.7], [21.98, 34.6], "bld"],
];
const START = 1; // side yard, by the entrance
const spotIndex = (id) => SPOTS.findIndex(([n]) => n.toLowerCase() === String(id || "").toLowerCase());
const slug = (id) => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Which area you are in (Blender x0, y0, x1, y1; first match wins). Rooms come from
// build_house.py's partitions; anywhere else outdoors counts as the nearest outdoor spot.
const AREAS = [
  ["Bedroom", 0.3, 0.3, 5.0, 4.0], ["Kids room", 5.0, 0.3, 8.5, 4.0],
  ["Hall", 0.3, 4.0, 5.0, 9.3], ["Hall #2", 5.0, 4.0, 8.5, 9.3],
  ["Kitchen", 8.5, 0.3, 10.7, 4.8], ["Hallway", 8.5, 4.8, 10.7, 7.0], ["Bathroom", 8.5, 7.0, 10.7, 9.3],
  ["Extension room", 10.7, 4.0, 13.0, 7.06], ["Stairs", 10.7, 7.06, 13.0, 8.75],
  ["Garage", 16.2, -1.3, 22.0, 4.75], ["Workshop", 16.2, 4.75, 22.0, 9.7],
  ["Bath house", 18.8, 11.5, 21.9, 14.1], ["Toilet", 21.4, 32.7, 22.6, 34.2],
].map(([id, ...r]) => [spotIndex(id), ...r]);
let areaLock = null;   // a teleported-to spot stays "here" until you walk a metre away
function areaAt(bx, by, bz) {
  if (bz < -0.95) return spotIndex("Cellar");               // below yard level: the cellar and its stairs
  for (const [i, x0, y0, x1, y1] of AREAS) if (bx >= x0 && bx < x1 && by >= y0 && by < y1) return i;
  let best = 0, bd = Infinity;
  SPOTS.forEach(([, , [x, y], , g], i) => {
    if (g !== "out") return;
    const d = (x - bx) ** 2 + (y - by) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

// ------------------------------------------------------------------ language
const STR = {
  uk: {
    title: "Прогулянка будинком", loading: "Завантаження будинку…",
    loadingPct: "Завантаження будинку… {p}% з {mb} МБ", opening: "Відкриваємо будинок…",
    loadError: "Не вдалося завантажити будинок",
    deskHelp1: "Миша — огляд · WASD або стрілки — ходьба · Shift — біг · Esc — пауза",
    deskHelp2: "M — план · H — налаштування й довідка. Якщо миша не повертає погляд, тягніть мишею або гортайте двома пальцями",
    mobHelp: "Лівий джойстик — ходьба · проведіть праворуч — огляд",
    clickStart: "Натисніть, щоб почати", tapStart: "Торкніться, щоб почати",
    private: "Модель приватна. Введіть пароль.", password: "Пароль", open: "Відкрити",
    remember: "Запам'ятати на цьому пристрої", checking: "Перевіряємо…", wrongPw: "Неправильний пароль",
    cantOpen: "Не вдалося відкрити модель",
    settings: "Налаштування", language: "Мова", quality: "Якість", qAuto: "Авто", qHigh: "Висока", qLow: "Низька",
    controls: "Керування", forget: "Забути збережений пароль", forgotten: "Пароль забуто на цьому пристрої",
    minimap: "Міні-план", hide: "Сховати", show: "Показати", openMap: "Відкрити план",
    map: "План", mapHint: "Натисніть на плані, щоб перейти туди", close: "Закрити",
    autoLow: "Увімкнено низьку якість для плавнішого руху",
    out: "Двір", house: "Будинок", bld: "Будівлі",
    ctl: [["Миша", "огляд"], ["W A S D, стрілки", "ходьба"], ["Shift", "біг"], ["1–9", "перейти до місця"],
      ["M", "план"], ["H", "ця панель"], ["Esc", "пауза, закрити"]],
  },
  en: {
    title: "House walkthrough", loading: "Loading the house…",
    loadingPct: "Loading the house… {p}% of {mb} MB", opening: "Opening the house…",
    loadError: "Couldn't load the house",
    deskHelp1: "Mouse to look · WASD or arrows to walk · Shift to run · Esc to pause",
    deskHelp2: "M for the map · H for settings and help. If the mouse doesn't turn the view, drag or two-finger scroll to look",
    mobHelp: "Left stick to walk · drag on the right to look",
    clickStart: "Click to start", tapStart: "Tap to start",
    private: "This model is private. Enter the password.", password: "Password", open: "Open",
    remember: "Remember on this device", checking: "Checking…", wrongPw: "Wrong password",
    cantOpen: "Couldn't open the model",
    settings: "Settings", language: "Language", quality: "Quality", qAuto: "Auto", qHigh: "High", qLow: "Low",
    controls: "Controls", forget: "Forget the saved password", forgotten: "Password forgotten on this device",
    minimap: "Mini-map", hide: "Hide", show: "Show", openMap: "Open the map",
    map: "Map", mapHint: "Click on the map to go there", close: "Close",
    autoLow: "Switched to low quality for smoother movement",
    out: "Outside", house: "House", bld: "Yard buildings",
    ctl: [["Mouse", "look"], ["W A S D, arrows", "walk"], ["Shift", "run"], ["1–9", "jump to a spot"],
      ["M", "map"], ["H", "this panel"], ["Esc", "pause, close"]],
  },
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* blocked */ } },
};
let lang = store.get("house-lang") === "en" ? "en" : "uk";
const t = (k, vars = {}) => (STR[lang][k] ?? STR.en[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => vars[v]);
const spotName = (i) => (lang === "uk" ? SPOTS[i][1] : SPOTS[i][0]);

// Objects that don't block walking: gates and the entrance door (you pass through them), the heavy fence
// ornaments (the panels behind them block), and flat ground pieces.
const NO_COLLIDE = /^(GreyGate|Entrance_Door|Entrance_Glass|Garage_SideDoor|Workshop_SideDoor|Workshop_BackDoor|Workshop_FarDoor|Toilet_Door|Bath_Door|Cellar_Door|Cellar_Steps|Garage_PitSteps|.*_Ornaments|Surroundings|Road|Yard|Back_Lawn|FrontGarden|Garden_Soil|CropRow|Flowers|Path_|GardenPath|HBar_Cable|HBar_Anchor|WellYard|Apron|Paving_Curb|TreeBed|Cat_)/;

const INDOOR_GLOW = { Ceiling: 0.75, InteriorWall: 0.35, WallpaperPink: 0.3, WallpaperPeach: 0.3, WallpaperCream: 0.3, WallpaperStripe: 0.3, PanelLeaf: 0.3, KitchenWall: 0.3, WallpaperPlain: 0.3, PanelPVC: 0.3 };

const b2t = (x, y, z = 0) => new THREE.Vector3(x, z, -y);

// ------------------------------------------------------------------ renderer and scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // static scene and sun: render shadows once
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const sky = new THREE.Color(0.62, 0.70, 0.80);
scene.background = sky;
scene.fog = new THREE.Fog(sky, 60, 160);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 400);
camera.rotation.order = "YXZ";

scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x6b5a45, 1.4));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
const SITE = b2t(11, 12);
sun.position.copy(SITE).add(new THREE.Vector3(-18, 30, 14));
sun.target.position.copy(SITE);
sun.castShadow = true;
sun.shadow.mapSize.set(IS_TOUCH ? 2048 : 4096, IS_TOUCH ? 2048 : 4096);
Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 120 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);


// ------------------------------------------------------------------ player state
const player = { feet: new THREE.Vector3(), vy: 0, yaw: 0, pitch: 0, eyeY: 0 };
const keys = new Set();
const joy = { x: 0, y: 0 };      // -1..1, y forward
let active = false;              // input enabled (pointer locked or touch started)

let colliders = [], grounds = []; // { mesh, box }

function near(list, p, margin) {
  const out = [];
  for (const c of list) if (c.box.distanceToPoint(p) < margin) out.push(c.mesh);
  return out;
}

const ray = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _o = new THREE.Vector3();

function groundAt(p, from) {
  _o.set(p.x, from, p.z);
  ray.set(_o, DOWN);
  ray.far = 60;
  // the search must reach down from `from` to the feet (a teleport starts 1.2 m up)
  const hits = ray.intersectObjects(near(grounds, _o, 1.0 + Math.max(0, from - p.y)), false);
  return hits.length ? hits[0].point.y : null;
}

function resolveWalls(p) {
  const meshes = near(colliders, p, RADIUS + 1.6);
  if (!meshes.length) return;
  for (let iter = 0; iter < 2; iter++) {
    for (const h of [STEP + 0.05, 1.0, 1.55]) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        _v.set(Math.cos(a), 0, Math.sin(a));
        _o.set(p.x, p.y + h, p.z);
        ray.set(_o, _v);
        ray.far = RADIUS;
        const hit = ray.intersectObjects(meshes, false)[0];
        if (!hit) continue;
        _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        _n.y = 0;
        if (_n.lengthSq() < 1e-4) continue;
        _n.normalize();
        if (_n.dot(_v) > 0) _n.negate();
        // push out along the wall normal by the penetration depth
        const depth = (RADIUS - hit.distance) * -_n.dot(_v);
        p.addScaledVector(_n, depth + 1e-3);
      }
    }
  }
}

// put the player at Blender (x, y) facing yaw; `from` is where the ground search starts
// (below the house ceiling, 2.7 m, above any floor)
function placeAt(x, y, yaw, from = 1.2) {
  const p = b2t(x, y);
  const g = groundAt(p, from);
  player.feet.set(p.x, g ?? -0.7, p.z); // yard level (plinth_height)
  resolveWalls(player.feet);
  player.vy = 0;
  player.yaw = yaw;
  player.pitch = 0;
  player.eyeY = player.feet.y + EYE;
}
function teleport(i) {
  const [, , [x, y], [tx, ty]] = SPOTS[i];
  const p = b2t(x, y), t = b2t(tx, ty);
  placeAt(x, y, Math.atan2(-(t.x - p.x), -(t.z - p.z)));
  areaLock = { i, x: player.feet.x, z: player.feet.z };
}

function update(dt) {
  const fwd = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  let mx = 0, my = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) my += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) my -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
  mx += joy.x; my += joy.y;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  const running = keys.has("ShiftLeft") || keys.has("ShiftRight") || Math.hypot(joy.x, joy.y) > 0.92;
  const speed = active && !mapOpen ? (running ? RUN : WALK) : 0;
  const move = fwd.multiplyScalar(my * speed * dt).addScaledVector(right, mx * speed * dt);

  // move in small substeps so fast motion can't tunnel through thin walls
  const steps = Math.max(1, Math.ceil(move.length() / 0.1));
  move.divideScalar(steps);
  const p = player.feet;
  for (let s = 0; s < steps; s++) {
    p.add(move);
    resolveWalls(p);
  }
  // ground follow: step up onto anything below knee height, otherwise fall
  const g = groundAt(p, p.y + STEP);
  if (g !== null && g >= p.y - 0.02) {
    p.y = g; player.vy = 0;
  } else {
    player.vy -= GRAVITY * dt;
    p.y += player.vy * dt;
    if (g !== null && p.y < g) { p.y = g; player.vy = 0; }
    if (g === null && p.y < -5) teleport(START);
  }
  // smooth the eye over steps
  const target = p.y + EYE;
  player.eyeY += (target - player.eyeY) * Math.min(1, dt * 12);
  if (Math.abs(target - player.eyeY) > 1) player.eyeY = target;
  camera.position.set(p.x, player.eyeY, p.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
}

// ------------------------------------------------------------------ UI state
const $ = (id) => document.getElementById(id);
const overlay = $("overlay"), canvas = renderer.domElement, bar = $("teleports"), status = $("status");
const settingsEl = $("settings"), mapEl = $("map"), mapcv = $("mapcv"), mini = $("minimap");
const fadeEl = $("fade"), labelEl = $("roomlabel"), toastEl = $("toast");
const Q = new URLSearchParams(location.search);
const SHOT = Q.has("shot");          // screenshot mode: no UI at all
if (SHOT) document.body.classList.add("shot");
let mapOpen = false;
let start = () => {};                // begin walking (pointer lock on desktop)
let pauseInput = () => {};           // leave pointer lock (desktop)
let currentArea = -1;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

// teleport behind a short fade to black
function fadeTo(fn) {
  if (REDUCED_MOTION) return fn();
  fadeEl.classList.add("on");
  setTimeout(() => { fn(); requestAnimationFrame(() => requestAnimationFrame(() => fadeEl.classList.remove("on"))); }, 180);
}
const goSpot = (i) => fadeTo(() => teleport(i));

function look(dx, dy, k) {
  player.yaw -= dx * k;
  player.pitch = THREE.MathUtils.clamp(player.pitch - dy * k, -1.45, 1.45);
}

// ------------------------------------------------------------------ input: desktop
if (!IS_TOUCH) {
  overlay.querySelector(".mob").remove();
  // Pointer lock is refused in some embedded browsers (e.g. app preview panes). Then we
  // start anyway in "drag mode": click-drag or two-finger trackpad scroll to look.
  let dragMode = false, dragging = false;
  const setActive = (v) => {
    active = v;
    overlay.classList.toggle("hidden", v || mapOpen);
    if (!v) keys.clear();
  };
  const startDragMode = () => {
    if (dragMode && active) return;
    dragMode = true;
    document.body.classList.add("drag-look");
    setActive(true);
  };
  start = () => {
    if (dragMode) return startDragMode();
    if (document.pointerLockElement === canvas) return;
    try {
      const p = canvas.requestPointerLock();
      if (p && p.catch) p.catch(startDragMode);
    } catch {
      startDragMode();
    }
  };
  pauseInput = () => { if (document.pointerLockElement) document.exitPointerLock(); };
  overlay.addEventListener("click", () => { closeSettings(); start(); });
  document.addEventListener("pointerlockerror", startDragMode);
  document.addEventListener("pointerlockchange", () => {
    if (!dragMode) setActive(document.pointerLockElement === canvas);
  });
  document.addEventListener("mousemove", (e) => {
    if (!active || mapOpen) return;
    if (!dragMode) look(e.movementX, e.movementY, 0.0022);
    else if (dragging) look(e.movementX, e.movementY, 0.004);
  });
  canvas.addEventListener("mousedown", () => { dragging = true; });
  addEventListener("mouseup", () => { dragging = false; });
  canvas.addEventListener("wheel", (e) => {
    if (!active || !dragMode) return;
    e.preventDefault();
    look(e.deltaX, e.deltaY, 0.003);
  }, { passive: false });
  addEventListener("keydown", (e) => {
    if (e.code === "Escape" && (mapOpen || settingsEl.classList.contains("open"))) {
      closeMap(false); closeSettings(); return;
    }
    if (e.code === "KeyM" && document.body.classList.contains("has-plan")) return mapOpen ? closeMap(true) : openMap();
    if (e.code === "KeyH") return toggleSettings();
    if (dragMode && e.code === "Escape") return setActive(!active);
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
    keys.add(e.code);
    const n = Number(e.key);
    if (n >= 1 && n <= Math.min(9, SPOTS.length) && player.ready) goSpot(n - 1);
  });
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());
}

// ------------------------------------------------------------------ input: touch
if (IS_TOUCH) {
  document.body.classList.add("touch");
  overlay.querySelectorAll(".desk").forEach((el) => el.remove());
  overlay.querySelector(".go").dataset.i18n = "tapStart";
  $("ctlbox").remove();                               // keyboard help is for desktops
  start = () => { active = true; overlay.classList.add("hidden"); };
  overlay.addEventListener("click", () => { closeSettings(); start(); });
  const pad = $("joy"), knob = pad.querySelector(".knob");
  let joyId = null;
  const setJoy = (e) => {
    const r = pad.getBoundingClientRect();
    const R = r.width / 2, travel = R - knob.offsetWidth / 2;   // knob stops at the rim
    let dx = (e.clientX - r.left - R) / travel, dy = (e.clientY - r.top - R) / travel;
    const l = Math.hypot(dx, dy);
    if (l > 1) { dx /= l; dy /= l; }
    knob.style.transform = `translate(${dx * travel}px, ${dy * travel}px)`;
    // small dead zone round the centre so a resting thumb doesn't creep
    const DEAD = 0.12, m = Math.min(l, 1), k = m < DEAD ? 0 : (m - DEAD) / (1 - DEAD) / (m || 1);
    joy.x = dx * k; joy.y = -dy * k;
  };
  pad.addEventListener("pointerdown", (e) => {
    joyId = e.pointerId;
    try { pad.setPointerCapture(joyId); } catch { /* synthetic or already released */ }
    setJoy(e);
  });
  pad.addEventListener("pointermove", (e) => { if (e.pointerId === joyId) setJoy(e); });
  const endJoy = (e) => {
    if (e.pointerId !== joyId) return;
    joyId = null; joy.x = joy.y = 0; knob.style.transform = "";
  };
  pad.addEventListener("pointerup", endJoy);
  pad.addEventListener("pointercancel", endJoy);
  const lookers = new Map();
  canvas.addEventListener("pointerdown", (e) => lookers.set(e.pointerId, [e.clientX, e.clientY]));
  canvas.addEventListener("pointermove", (e) => {
    const last = lookers.get(e.pointerId);
    if (!last) return;
    look(e.clientX - last[0], e.clientY - last[1], 0.005);
    lookers.set(e.pointerId, [e.clientX, e.clientY]);
  });
  for (const ev of ["pointerup", "pointercancel"]) canvas.addEventListener(ev, (e) => lookers.delete(e.pointerId));
}

// ------------------------------------------------------------------ area buttons
// The buttons sit above the start overlay: a click teleports and starts walking at once.
const buttons = [];
function buildButtons() {
  bar.textContent = "";
  for (const g of ["out", "house", "bld"]) {
    const grp = document.createElement("div");
    grp.className = "grp";
    const lab = document.createElement("span");
    lab.className = "glabel";
    lab.textContent = t(g);
    grp.append(lab);
    SPOTS.forEach(([, , , , sg], i) => {
      if (sg !== g) return;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = !IS_TOUCH && i < 9 ? `${i + 1} ${spotName(i)}` : spotName(i);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        closeSettings();
        if (!player.ready) return;
        goSpot(i);
        if (!active) start();
      });
      buttons[i] = b;
      grp.append(b);
    });
    bar.append(grp);
  }
  markArea(currentArea, false);
}

function markArea(i, scroll = true) {
  buttons.forEach((b, j) => b.classList.toggle("here", j === i));
  const b = buttons[i];
  if (!b || !scroll || bar.scrollWidth <= bar.clientWidth) return;
  const left = b.offsetLeft - (bar.clientWidth - b.offsetWidth) / 2;
  bar.scrollTo({ left, behavior: REDUCED_MOTION ? "auto" : "smooth" });
}

function showLabel(text) {
  labelEl.textContent = text;
  labelEl.classList.add("show");
  clearTimeout(showLabel.t);
  showLabel.t = setTimeout(() => labelEl.classList.remove("show"), 1600);
}

// links: #kitchen opens the kitchen; the address follows you round the house
function hashSpot() { return SPOTS.findIndex(([id]) => slug(id) === decodeURIComponent(location.hash.slice(1)).toLowerCase()); }
addEventListener("hashchange", () => { const i = hashSpot(); if (i >= 0 && player.ready) goSpot(i); });

function checkArea() {
  const p = player.feet;
  if (areaLock && Math.hypot(p.x - areaLock.x, p.z - areaLock.z) > 1) areaLock = null;
  const i = areaLock ? areaLock.i : areaAt(p.x, -p.z, p.y);
  if (i === currentArea) return;
  currentArea = i;
  markArea(i);
  if (!SHOT) showLabel(spotName(i));
  history.replaceState(null, "", `${location.pathname}${location.search}#${slug(SPOTS[i][0])}`);
}

// ------------------------------------------------------------------ settings, language, quality
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  const ctl = $("controls");
  if (ctl) ctl.innerHTML = STR[lang].ctl.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join("");
  document.querySelectorAll("#langseg button").forEach((b) => b.classList.toggle("on", b.dataset.v === lang));
  buildButtons();
  if (mapOpen) drawMap();
}

let quality = ["high", "low"].includes(store.get("house-quality")) ? store.get("house-quality") : "auto";
let lowNow = null;
function setLow(low) {
  if (low === lowNow) return;
  lowNow = low;
  renderer.setPixelRatio(low ? 1 : Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  const s = low ? 1024 : IS_TOUCH ? 2048 : 4096;
  if (sun.shadow.mapSize.x !== s) {
    sun.shadow.mapSize.set(s, s);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    renderer.shadowMap.needsUpdate = true;
  }
}
function setQuality(q) {
  quality = q;
  store.set("house-quality", q === "auto" ? null : q);
  document.querySelectorAll("#qseg button").forEach((b) => b.classList.toggle("on", b.dataset.v === q));
  if (q !== "auto") setLow(q === "low");
  else { setLow(false); fps.done = false; fps.n = 0; fps.time = 0; }
}
// Auto: after a short warm-up, measure a few seconds of walking; under ~30 fps go low.
const fps = { n: 0, time: 0, done: false };
function measure(dt) {
  if (quality !== "auto" || fps.done || !active || mapOpen || document.hidden) return;
  fps.time += dt; fps.n++;
  if (fps.time < 1.5) { fps.warm = fps.n; return; }
  if (fps.time < 5.5) return;
  fps.done = true;
  const rate = (fps.n - fps.warm) / (fps.time - 1.5);
  if (rate < 30) { setLow(true); toast(t("autoLow")); }
}

function toggleSettings() { settingsEl.classList.toggle("open"); }
function closeSettings() { settingsEl.classList.remove("open"); }
$("gear").addEventListener("click", (e) => { e.stopPropagation(); toggleSettings(); });
settingsEl.querySelector(".x").addEventListener("click", closeSettings);
document.querySelectorAll("#langseg button").forEach((b) => b.addEventListener("click", () => {
  lang = b.dataset.v;
  store.set("house-lang", lang);
  applyLang();
}));
document.querySelectorAll("#qseg button").forEach((b) => b.addEventListener("click", () => setQuality(b.dataset.v)));
// the mini-map is off unless asked for (keeps the screen clear); the full map is in settings or M
function setMini(on) {
  document.body.classList.toggle("mini-on", on);
  store.set("house-mini", on ? "1" : null);
  document.querySelectorAll("#miniseg button").forEach((b) => b.classList.toggle("on", (b.dataset.v === "on") === on));
}
setMini(store.get("house-mini") === "1");
document.querySelectorAll("#miniseg button").forEach((b) => b.addEventListener("click", () => setMini(b.dataset.v === "on")));
$("openmap").addEventListener("click", () => openMap());
const forgetBtn = $("forget");
const updateForget = () => { forgetBtn.style.display = store.get(KEY_STORE) ? "" : "none"; };
forgetBtn.addEventListener("click", () => { store.set(KEY_STORE, null); updateForget(); toast(t("forgotten")); });

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (mapOpen) drawMap();
});

// ------------------------------------------------------------------ plan (map)
// Rendered once from above with everything above 1.4 m cut away: flat colours for the
// floors and furniture, and the cut walls (seen from inside, i.e. back faces) in dark.
const PLAN = { x0: -1, y0: -8, x1: 25, y1: 36, ppm: 20 };
let planCv = null;
function makePlan() {
  const w = PLAN.x1 - PLAN.x0, h = PLAN.y1 - PLAN.y0;
  const W = Math.round(w * PLAN.ppm), H = Math.round(h * PLAN.ppm);
  const cx = (PLAN.x0 + PLAN.x1) / 2, cy = (PLAN.y0 + PLAN.y1) / 2;
  const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 1, 200);
  cam.up.set(0, 0, -1);
  cam.position.set(cx, 80, -cy);
  cam.lookAt(cx, 0, -cy);
  const keep = { pr: renderer.getPixelRatio(), fog: scene.fog, bg: scene.background, tm: renderer.toneMapping };
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  scene.fog = null;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.4)];
  planCv = document.createElement("canvas");
  planCv.width = W; planCv.height = H;
  const ctx = planCv.getContext("2d");
  // pass 1: unlit colours
  const flat = new Map(), swapped = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    if (!flat.has(m)) flat.set(m, new THREE.MeshBasicMaterial({ color: m.color, map: m.map ?? null,
      transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest, side: m.side }));
    swapped.push([o, m]);
    o.material = flat.get(m);
  });
  scene.background = new THREE.Color(0xe8e3d6);
  renderer.render(scene, cam);
  ctx.drawImage(canvas, 0, 0);
  for (const [o, m] of swapped) o.material = m;
  flat.forEach((m) => m.dispose());
  // pass 2: what you see of a cut-open solid from above is its inside: back faces dark
  const mask = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  mask.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace("#include <dithering_fragment>",
      "#include <dithering_fragment>\n gl_FragColor = gl_FrontFacing ? vec4(1.0) : vec4(0.17, 0.15, 0.14, 1.0);");
  };
  scene.overrideMaterial = mask;
  scene.background = new THREE.Color(0xffffff);
  renderer.render(scene, cam);
  ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(canvas, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  scene.overrideMaterial = null;
  mask.dispose();
  renderer.clippingPlanes = [];
  scene.fog = keep.fog; scene.background = keep.bg; renderer.toneMapping = keep.tm;
  renderer.setPixelRatio(keep.pr);
  renderer.setSize(innerWidth, innerHeight);
  document.body.classList.add("has-plan");
}
const toPlan = (bx, by) => [(bx - PLAN.x0) * PLAN.ppm, (PLAN.y1 - by) * PLAN.ppm];

function drawArrow(ctx, x, y, r) {
  // forward in Blender is (-sin yaw, cos yaw); the canvas y axis points down
  const a = Math.atan2(-Math.cos(player.yaw), -Math.sin(player.yaw));
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(r * 1.5, 0); ctx.lineTo(-r, r); ctx.lineTo(-r * 0.4, 0); ctx.lineTo(-r, -r); ctx.closePath();
  ctx.fillStyle = "#d9412b"; ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(1.5, r * 0.25);
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

// mini-map: a 16 m window round you, north (the back garden) up
function drawMini() {
  if (!planCv || mini.offsetWidth === 0) return;
  const dpr = Math.min(devicePixelRatio, 2), S = Math.round(mini.clientWidth * dpr);
  if (mini.width !== S) { mini.width = S; mini.height = S; }
  const ctx = mini.getContext("2d");
  const span = 16 * PLAN.ppm;
  const [px, py] = toPlan(player.feet.x, -player.feet.z);
  ctx.fillStyle = "#e8e3d6";
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(planCv, px - span / 2, py - span / 2, span, span, 0, 0, S, S);
  drawArrow(ctx, S / 2, S / 2, S * 0.06);
}

// full map: tap anywhere to go there, or on a spot's dot
let mapFit = null;
function drawMap() {
  const head = mapEl.querySelector("header").offsetHeight + 8;
  const maxW = Math.min(innerWidth - 24, 640), maxH = innerHeight - 24 - head;
  const s = Math.min(maxW / planCv.width, maxH / planCv.height);
  const w = Math.round(planCv.width * s), h = Math.round(planCv.height * s);
  const dpr = Math.min(devicePixelRatio, 2);
  mapcv.style.width = `${w}px`; mapcv.style.height = `${h}px`;
  mapcv.width = Math.round(w * dpr); mapcv.height = Math.round(h * dpr);
  mapFit = s * dpr;
  const ctx = mapcv.getContext("2d");
  ctx.drawImage(planCv, 0, 0, mapcv.width, mapcv.height);
  ctx.font = `600 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  SPOTS.forEach(([, , [x, y]], i) => {
    const [u, v] = toPlan(x, y).map((c) => c * mapFit);
    ctx.beginPath();
    ctx.arc(u, v, 5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = i === currentArea ? "#e3b46c" : "#2b5f8a";
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * dpr;
    ctx.fill(); ctx.stroke();
    ctx.lineWidth = 3 * dpr; ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.fillStyle = "#1d1d1d";
    ctx.strokeText(spotName(i), u + 8 * dpr, v);
    ctx.fillText(spotName(i), u + 8 * dpr, v);
  });
  const [u, v] = toPlan(player.feet.x, -player.feet.z).map((c) => c * mapFit);
  drawArrow(ctx, u, v, 8 * dpr);
}
function openMap() {
  if (!planCv) return;
  closeSettings();
  pauseInput();
  mapOpen = true;
  keys.clear();
  overlay.classList.add("hidden");
  mapEl.classList.add("open");
  drawMap();
}
function closeMap(resume) {
  if (!mapOpen) return;
  mapOpen = false;
  mapEl.classList.remove("open");
  if (resume) start();
  if (!active) overlay.classList.remove("hidden");
}
mini.addEventListener("click", (e) => { e.stopPropagation(); openMap(); });
mapEl.querySelector(".x").addEventListener("click", () => closeMap(true));
mapEl.addEventListener("click", (e) => { if (e.target === mapEl) closeMap(true); });
mapcv.addEventListener("click", (e) => {
  const r = mapcv.getBoundingClientRect(), dpr = mapcv.width / r.width;
  const u = (e.clientX - r.left) * dpr, v = (e.clientY - r.top) * dpr;
  // a spot's dot (or its name) wins over the bare floor under it
  let hit = -1, hd = (14 * dpr) ** 2;
  SPOTS.forEach(([, , [x, y]], i) => {
    const [a, b] = toPlan(x, y).map((c) => c * mapFit);
    const d = (a - u) ** 2 + (b - v) ** 2;
    if (d < hd) { hd = d; hit = i; }
  });
  const bx = u / mapFit / PLAN.ppm + PLAN.x0, by = PLAN.y1 - v / mapFit / PLAN.ppm;
  closeMap(true);
  fadeTo(() => (hit >= 0 ? teleport(hit) : placeAt(bx, by, player.yaw)));
});

// ------------------------------------------------------------------ load
function onModel(gltf) {
  const root = gltf.scene;
  scene.add(root);
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.name;
    const far = /^Surroundings/.test(name);
    const mat = o.material;
    // see-through nets would cast solid shadows (the shadow map ignores opacity)
    o.castShadow = !far && !mat.transparent;
    o.receiveShadow = true;
    if (mat.map) mat.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
    // indoors only the sky light reaches, and it paints ceilings with its ground colour:
    // let painted walls and ceilings glow a little, as if the room lights were on
    const glow = INDOOR_GLOW[mat.name];
    if (glow && !mat.userData.glow) {
      mat.emissive.copy(mat.color).multiplyScalar(glow);
      mat.userData.glow = true;
    }
    const entry = { mesh: o, box: new THREE.Box3().setFromObject(o) };
    if (o.geometry.index && o.geometry.index.count > 300) o.geometry.computeBoundsTree();
    if (!/^Cat_/.test(name)) grounds.push(entry); // you can't stand on a cat
    if (!NO_COLLIDE.test(name)) colliders.push(entry);
  });
  renderer.shadowMap.needsUpdate = true;
  status.remove();
  bar.style.display = "";
  if (!SHOT) { try { makePlan(); } catch (err) { console.error("plan", err); } }
  // #kitchen, or ?spot=Kitchen, starts at that spot; &shot hides all the UI (screenshots)
  const hi = hashSpot(), si = spotIndex(Q.get("spot"));
  teleport(hi >= 0 ? hi : si >= 0 ? si : START);
  player.ready = true;
  if (SHOT) document.body.dataset.ready = "1";
  else overlay.classList.remove("hidden");
}
function onLoadError(err) {
  status.textContent = t("loadError");
  console.error(err);
}
const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);
const progress = (got, total) => {
  if (total) status.textContent = t("loadingPct", { p: Math.round((100 * got) / total), mb: mb(total) });
};

// The published copy (tools/publish_web.py) sets window.HOUSE_ENCRYPTED to an encrypted
// model: ask for the password, check it and decrypt in the browser. Locally the plain
// house.glb loads as before.
const KEY_STORE = "house-key";
applyLang();
setQuality(quality);
updateForget();
if (window.HOUSE_ENCRYPTED) unlockAndLoad(window.HOUSE_ENCRYPTED);
else new GLTFLoader().load("house.glb", onModel, (e) => progress(e.loaded, e.total), onLoadError);

// File layout (see tools/publish_web.py): "HWE1", PBKDF2 iterations (uint32, big-endian),
// salt (16), AES-CTR counter block (16), ciphertext, HMAC-SHA256 tag (32) over everything
// before it. PBKDF2-SHA256(password) gives 64 bytes: the AES-256 key, then the HMAC key.
async function fetchWithProgress(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    progress(got, total);
  }
  const buf = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  return buf;
}

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const fileSalt = (file) => file.subarray(8, 24);
async function deriveKeys(file, password) {
  if (new TextDecoder().decode(file.subarray(0, 4)) !== "HWE1") throw new Error("not a model file");
  const iterations = new DataView(file.buffer, file.byteOffset + 4, 4).getUint32(0);
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fileSalt(file), iterations }, base, 512));
}
// null when the keys don't match the file (wrong password)
async function decryptModel(file, bits) {
  const counter = file.subarray(24, 40);
  const body = file.subarray(0, file.length - 32), tag = file.subarray(file.length - 32);
  const ct = file.subarray(40, file.length - 32);
  const macKey = await crypto.subtle.importKey("raw", bits.subarray(32), { name: "HMAC", hash: "SHA-256" },
    false, ["verify"]);
  if (!(await crypto.subtle.verify("HMAC", macKey, tag, body))) return null;
  const aesKey = await crypto.subtle.importKey("raw", bits.subarray(0, 32), "AES-CTR", false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-CTR", counter, length: 128 }, aesKey, ct);
}

function openPlain(plain) {
  bar.style.display = "";
  status.style.display = "";
  status.dataset.i18n = "opening";
  status.textContent = t("opening");
  new GLTFLoader().parse(plain, "", onModel, onLoadError);
}

async function unlockAndLoad(url) {
  bar.style.display = "none";                       // no room names before the password
  let file;
  try { file = await fetchWithProgress(url); } catch (err) { return onLoadError(err); }
  // "Remember on this device" keeps the derived keys (not the password) for this file's salt
  try {
    const saved = JSON.parse(store.get(KEY_STORE) || "null");
    if (saved && saved.salt === hex(fileSalt(file))) {
      const plain = await decryptModel(file, unhex(saved.keys));
      if (plain) return openPlain(plain);
    }
    if (saved) { store.set(KEY_STORE, null); updateForget(); }
  } catch (err) { console.error(err); }
  status.style.display = "none";
  const box = document.createElement("form");
  box.id = "unlock";
  box.innerHTML = `<h1 data-i18n="title"></h1><p data-i18n="private"></p>
    <input type="password" autocomplete="current-password" data-i18n-ph="password" autofocus>
    <label><input type="checkbox"><span data-i18n="remember"></span></label>
    <button type="submit" data-i18n="open"></button><p class="err"></p>`;
  document.body.append(box);
  applyLang();
  const input = box.querySelector("input[type=password]"), err = box.querySelector(".err");
  const remember = box.querySelector("input[type=checkbox]");
  const btn = box.querySelector("button");
  // typing digits must not teleport, letters must not walk or open panels
  for (const ev of ["keydown", "keyup"]) box.addEventListener(ev, (e) => e.stopPropagation());
  input.focus();
  box.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    err.textContent = t("checking");
    try {
      const bits = await deriveKeys(file, input.value);
      const plain = await decryptModel(file, bits);
      if (!plain) {
        err.textContent = t("wrongPw");
        btn.disabled = false;
        input.select();
        return;
      }
      if (remember.checked) {
        store.set(KEY_STORE, JSON.stringify({ salt: hex(fileSalt(file)), keys: hex(bits) }));
        updateForget();
      }
      box.remove();
      openPlain(plain);
    } catch (ex) {
      err.textContent = t("cantOpen");
      btn.disabled = false;
      console.error(ex);
    }
  });
}

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
let areaT = 0, miniT = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  renderer.render(scene, camera);
  measure(dt);
  if (!player.ready || SHOT) return;
  if ((areaT += dt) > 0.25) { areaT = 0; checkArea(); }
  if ((miniT += dt) > 0.05) { miniT = 0; drawMini(); }
});

// for debugging and automated checks
window.walk = { step: update, render: () => renderer.render(scene, camera), player, teleport, keys, joy, setActive: (v) => { active = v; }, scene, camera, SPOTS, openMap, closeMap, setQuality, areaAt };
