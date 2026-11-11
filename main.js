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

// Teleports in Blender coordinates: position (x, y) and a point to look at.
const SPOTS = [
  ["Street", [13.5, -6.5], [13.5, 2.0]],
  ["Side yard", [14.5, 0.2], [14.0, 10.0]],
  ["Well", [14.0, 13.0], [12.0, 15.6]],
  ["Back garden", [12.3, 26.6], [11.0, 9.6]],
  ["Toilet path", [15.9, 17.7], [21.7, 33.4]],
  ["Entrance", [12.0, 10.6], [12.0, 8.0]],
  ["Bedroom", [2.75, 3.5], [2.75, 0.4]],
  ["Kids room", [6.42, 3.5], [6.42, 0.4]],
  ["Hall", [2.75, 4.4], [1.2, 8.6]],
  ["Hall #2", [6.45, 4.5], [6.6, 9.0]],
  ["Bathroom", [9.0, 8.35], [10.6, 8.3]],
  ["Kitchen", [9.45, 4.5], [9.5, 0.6]],
  ["Hallway", [8.9, 5.8], [10.6, 6.2]],
  ["Extension room", [11.3, 5.6], [12.8, 6.0]],
  ["Stairs", [11.9, 7.3], [11.8, 9.0]],
  ["Workshop", [16.8, 5.4], [19.4, 6.8]],
  ["Garage", [16.8, 4.0], [18.3, 0.0]],
  ["Bath house", [18.9, 12.4], [21.8, 12.6]],
  ["Cellar", [11.8, 10.2], [8.5, 10.2]],
  ["Toilet", [21.98, 32.7], [21.98, 34.6]],
];
const START = 1; // side yard, by the entrance

// Objects that don't block walking: gates and the entrance door (you pass through them), the heavy fence
// ornaments (the panels behind them block), and flat ground pieces.
const NO_COLLIDE = /^(GreyGate|Entrance_Door|Entrance_Glass|Garage_SideDoor|Workshop_SideDoor|Workshop_BackDoor|Workshop_FarDoor|Toilet_Door|Bath_Door|Cellar_Door|Cellar_Steps|Garage_PitSteps|.*_Ornaments|Surroundings|Road|Yard|Back_Lawn|FrontGarden|Garden_Soil|CropRow|Flowers|Path_|GardenPath|HBar_Cable|HBar_Anchor|WellYard|Apron|Paving_Curb|TreeBed|Cat_)/;

const INDOOR_GLOW = { Ceiling: 0.75, InteriorWall: 0.35, WallpaperPink: 0.3, WallpaperPeach: 0.3, WallpaperCream: 0.3, WallpaperStripe: 0.3, PanelLeaf: 0.3, KitchenWall: 0.3, WallpaperPlain: 0.3, PanelPVC: 0.3 };

const b2t = (x, y, z = 0) => new THREE.Vector3(x, z, -y);

// ------------------------------------------------------------------ renderer and scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
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

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

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

function teleport(i) {
  const [, [x, y], [tx, ty]] = SPOTS[i];
  const p = b2t(x, y), t = b2t(tx, ty);
  const g = groundAt(p, 1.2); // below the house ceiling (2.7 m), above any floor
  player.feet.set(p.x, g ?? -0.7, p.z); // yard level (plinth_height)
  player.vy = 0;
  player.yaw = Math.atan2(-(t.x - p.x), -(t.z - p.z));
  player.pitch = 0;
  player.eyeY = player.feet.y + EYE;
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
  const speed = active ? (running ? RUN : WALK) : 0;
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

// ------------------------------------------------------------------ input: desktop
const overlay = document.getElementById("overlay");
const canvas = renderer.domElement;
function look(dx, dy, k) {
  player.yaw -= dx * k;
  player.pitch = THREE.MathUtils.clamp(player.pitch - dy * k, -1.45, 1.45);
}
if (!IS_TOUCH) {
  overlay.querySelector(".mob").remove();
  // Pointer lock is refused in some embedded browsers (e.g. app preview panes). Then we
  // start anyway in "drag mode": click-drag or two-finger trackpad scroll to look.
  let dragMode = false, dragging = false;
  const setActive = (v) => {
    active = v;
    overlay.classList.toggle("hidden", v);
    if (!v) keys.clear();
  };
  const startDragMode = () => {
    if (dragMode && active) return;
    dragMode = true;
    document.body.classList.add("drag-look");
    setActive(true);
  };
  overlay.addEventListener("click", () => {
    if (dragMode) return startDragMode();
    try {
      const p = canvas.requestPointerLock();
      if (p && p.catch) p.catch(startDragMode);
    } catch {
      startDragMode();
    }
  });
  document.addEventListener("pointerlockerror", startDragMode);
  document.addEventListener("pointerlockchange", () => {
    if (!dragMode) setActive(document.pointerLockElement === canvas);
  });
  document.addEventListener("mousemove", (e) => {
    if (!active) return;
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
    if (dragMode && e.code === "Escape") return setActive(!active);
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
    keys.add(e.code);
    const n = Number(e.key);
    if (n >= 1 && n <= SPOTS.length) teleport(n - 1);
  });
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());
}

// ------------------------------------------------------------------ input: touch
if (IS_TOUCH) {
  document.body.classList.add("touch");
  overlay.querySelectorAll(".desk").forEach((el) => el.remove());
  overlay.querySelector(".go").textContent = "Tap to start";
  overlay.addEventListener("click", () => { active = true; overlay.classList.add("hidden"); });
  const pad = document.getElementById("joy"), knob = pad.querySelector(".knob");
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

// ------------------------------------------------------------------ teleport buttons
const bar = document.getElementById("teleports");
SPOTS.forEach(([name], i) => {
  const b = document.createElement("button");
  b.textContent = IS_TOUCH ? name : `${i + 1} ${name}`;
  b.addEventListener("click", (e) => { e.stopPropagation(); teleport(i); });
  bar.append(b);
});

// ------------------------------------------------------------------ load
const status = document.getElementById("status");
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
  // ?spot=Name starts at that spot; &shot also hides the overlay and buttons (screenshots)
  const q = new URLSearchParams(location.search);
  const si = SPOTS.findIndex(([n]) => n.toLowerCase() === (q.get("spot") || "").toLowerCase());
  teleport(si >= 0 ? si : START);
  if (q.has("shot")) {
    bar.style.display = "none";
    document.getElementById("joy").style.display = "none";
    document.getElementById("crosshair").style.display = "none";
    document.body.dataset.ready = "1";
  } else overlay.classList.remove("hidden");
}
function onLoadError(err) {
  status.textContent = "Couldn't load the house";
  console.error(err);
}

// The published copy (tools/publish_web.py) sets window.HOUSE_ENCRYPTED to an encrypted
// model: ask for the password, check it and decrypt in the browser. Locally the plain
// house.glb loads as before.
if (window.HOUSE_ENCRYPTED) unlockAndLoad(window.HOUSE_ENCRYPTED);
else new GLTFLoader().load("house.glb", onModel, (e) => {
  if (e.total) status.textContent = `Loading the house… ${Math.round((100 * e.loaded) / e.total)}%`;
}, onLoadError);

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
    if (total) status.textContent = `Downloading the house… ${Math.round((100 * got) / total)}%`;
  }
  const buf = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  return buf;
}

async function decryptModel(file, password) {
  const te = new TextEncoder();
  if (new TextDecoder().decode(file.subarray(0, 4)) !== "HWE1") throw new Error("not a model file");
  const iterations = new DataView(file.buffer, file.byteOffset + 4, 4).getUint32(0);
  const salt = file.subarray(8, 24), counter = file.subarray(24, 40);
  const body = file.subarray(0, file.length - 32), tag = file.subarray(file.length - 32);
  const ct = file.subarray(40, file.length - 32);
  const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 512));
  const macKey = await crypto.subtle.importKey("raw", bits.subarray(32), { name: "HMAC", hash: "SHA-256" },
    false, ["verify"]);
  if (!(await crypto.subtle.verify("HMAC", macKey, tag, body))) return null;   // wrong password
  const aesKey = await crypto.subtle.importKey("raw", bits.subarray(0, 32), "AES-CTR", false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-CTR", counter, length: 128 }, aesKey, ct);
}

async function unlockAndLoad(url) {
  let file;
  try { file = await fetchWithProgress(url); } catch (err) { return onLoadError(err); }
  status.style.display = "none";
  bar.style.display = "none";                       // no room names before the password
  const box = document.createElement("form");
  box.id = "unlock";
  box.innerHTML = `<h1>House walkthrough</h1><p>This model is private. Enter the password.</p>
    <input type="password" autocomplete="current-password" placeholder="Password" autofocus>
    <button type="submit">Open</button><p class="err"></p>`;
  document.body.append(box);
  const input = box.querySelector("input"), err = box.querySelector(".err");
  const btn = box.querySelector("button");
  // typing digits must not teleport, letters must not walk
  for (const ev of ["keydown", "keyup"]) input.addEventListener(ev, (e) => e.stopPropagation());
  input.focus();
  box.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    err.textContent = "Checking…";
    try {
      const plain = await decryptModel(file, input.value);
      if (!plain) {
        err.textContent = "Wrong password";
        btn.disabled = false;
        input.select();
        return;
      }
      box.remove();
      bar.style.display = "";
      status.style.display = "";
      status.textContent = "Opening the house…";
      new GLTFLoader().parse(plain, "", onModel, onLoadError);
    } catch (ex) {
      err.textContent = "Couldn't open the model";
      btn.disabled = false;
      console.error(ex);
    }
  });
}

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  renderer.render(scene, camera);
});

// for debugging and automated checks
window.walk = { step: update, render: () => renderer.render(scene, camera), player, teleport, keys, joy, setActive: (v) => { active = v; }, scene, camera, SPOTS };
