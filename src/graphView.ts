import * as THREE from "three";
import { BookNote, GraphBasis } from "./types";
import { buildGraph } from "./graph";
import { getMetadata } from "./note-metadata";

export interface GraphHandle {
  /** Tear down the WebGL scene. */
  cleanup: () => void;
  /**
   * Dim every note not in `highlightIds`. Pass `null` to clear (restore full
   * brightness).
   */
  setHighlight: (highlightIds: Set<string> | null) => void;
  /** Re-read cover colours and repaint the stars (after a cover is linked). */
  recolor: () => void;
}

// --- space look ---------------------------------------------------------
const HEIGHT = 260;
// Notes with no cover colour shine a pale starlight blue-white.
const DEFAULT_STAR = new THREE.Color("#cfe0ff");
const DIM_NODE = 0.12;

// "off" basis → a loose spherical shell of stars; otherwise the notes are
// arranged into a spiral galaxy whose shape reflects their relationships.
const R_MIN = 130;
const R_MAX = 340;

// Galaxy shape (scaled to fit the view via normalisation afterwards).
const GAL_R = 300;
const ARMS = 2;
const SPIRAL = 3.5;
const ARM_X_MEAN = 130;
const ARM_X_DIST = 240;
const ARM_Z_MEAN = 80;
const ARM_Z_DIST = 90;
const GALAXY_THICKNESS = 24;
const GALAXY_TILT = -1.15; // radians — lay the disc back so we see it at an angle

/** Crisp star sprite: solid bright core with a tight, faint halo. */
function makeStarTexture(): THREE.Texture {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.14, "rgba(255,255,255,1)");
  g.addColorStop(0.26, "rgba(255,255,255,0.55)");
  g.addColorStop(0.5, "rgba(255,255,255,0.12)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Cover tint "r,g,b" → a vivid (high-saturation) star colour. */
function coverStarColor(filePath: string): THREE.Color | null {
  const raw = getMetadata(filePath)?.coverColor;
  if (!raw) return null;
  const p = raw.split(",").map((n) => parseFloat(n) / 255);
  if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null;
  const c = new THREE.Color(p[0], p[1], p[2]);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, hsl.s * 1.7 + 0.2), Math.min(0.72, Math.max(0.55, hsl.l)));
  return c;
}

/** Normal-distributed sample (Box–Muller). */
function gaussian(mean: number, std: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Wind a point into a logarithmic spiral arm (galaxy plane = x/z). */
function spiral(x: number, y: number, z: number, offset: number): THREE.Vector3 {
  const r = Math.sqrt(x * x + z * z);
  let theta = offset;
  theta += x > 0 ? Math.atan(z / x) : Math.atan(z / x) + Math.PI;
  theta += (r / ARM_X_DIST) * SPIRAL;
  return new THREE.Vector3(r * Math.cos(theta), y, r * Math.sin(theta));
}

interface StarNode {
  id: string;
  title: string;
  degree: number;
  filePath: string;
  rating: number; // 0 (none/1★ look) … 5
  pos: THREE.Vector3; // position in the field's local space
}

export function renderGraph(
  container: HTMLElement,
  books: BookNote[],
  onOpen: (path: string) => void,
  basis: GraphBasis = "both",
): GraphHandle {
  const { nodes: rawNodes, links: rawLinks } = buildGraph(books, basis);
  const galaxy = basis !== "off";

  // 크기는 컨테이너(CSS)가 결정한다 — 와이드 2열 레이아웃에선 화면을 채운다.
  let width = container.clientWidth || 800;
  let height = container.clientHeight || HEIGHT;
  container.style.position = "relative";

  const ratingOf = new Map(books.map((b) => [b.filePath, b.frontmatter.rating ?? 0]));
  const maxDeg = Math.max(1, ...rawNodes.map((n) => n.degree));
  const heat = (deg: number) => Math.sqrt(deg / maxDeg); // 0..1, connectivity
  // Brightness follows the rating like a stellar magnitude: 5★ = brightest,
  // 1★ (and unrated) ≈ the old baseline. Size lifts a touch alongside it.
  const ratingNorm = (r: number) => (r > 0 ? Math.min(1, (r - 1) / 4) : 0);
  const starSize = (r: number) => 7 + 2.6 * ratingNorm(r);
  const baseOpacity = (r: number) => 0.8 + 0.2 * ratingNorm(r);
  const starColorFor = (filePath: string) => coverStarColor(filePath) ?? DEFAULT_STAR.clone();

  const nodes: StarNode[] = rawNodes.map((n) => ({
    id: n.id,
    title: n.title,
    degree: n.degree,
    filePath: n.filePath,
    rating: ratingOf.get(n.filePath) ?? 0,
    pos: new THREE.Vector3(),
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = rawLinks
    .map((l) => ({ s: byId.get(l.source as string), t: byId.get(l.target as string), ref: l.basis === "ref" }))
    .filter((l): l is { s: StarNode; t: StarNode; ref: boolean } => !!l.s && !!l.t);

  // --- layout -------------------------------------------------------------
  if (galaxy) {
    // Group connected notes (union-find) so each cluster lands on one arm —
    // the relationships shape the galaxy. Hubs (high degree) sink toward the
    // bright central bulge; loosely-linked notes drift out along the arms.
    const parent = new Map(nodes.map((n) => [n.id, n.id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(x) !== r) {
        const next = parent.get(x)!;
        parent.set(x, r);
        x = next;
      }
      return r;
    };
    for (const l of rawLinks) {
      const ra = find(l.source as string);
      const rb = find(l.target as string);
      if (ra !== rb) parent.set(ra, rb);
    }
    const armOfRoot = new Map<string, number>();
    let rootSeq = 0;
    const armFor = (id: string) => {
      const root = find(id);
      if (!armOfRoot.has(root)) armOfRoot.set(root, rootSeq++ % ARMS);
      return armOfRoot.get(root)!;
    };

    for (const n of nodes) {
      const inward = 1 - 0.45 * heat(n.degree);
      const x = gaussian(ARM_X_MEAN, ARM_X_DIST) * inward;
      const z = gaussian(ARM_Z_MEAN, ARM_Z_DIST) * inward;
      const y = gaussian(0, GALAXY_THICKNESS);
      n.pos.copy(spiral(x, y, z, (armFor(n.id) * 2 * Math.PI) / ARMS));
    }
    // Books that explicitly reference each other ([[…]]) are the strongest
    // tie — pull those pairs tightly together so they read as a close knot,
    // overriding the looser author/tag arm placement.
    const refLinks = links.filter((l) => l.ref);
    if (refLinks.length) {
      const REF_REST = 16;
      for (let it = 0; it < 60; it++) {
        for (const { s: a, t } of refLinks) {
          const dx = t.pos.x - a.pos.x;
          const dy = t.pos.y - a.pos.y;
          const dz = t.pos.z - a.pos.z;
          const d = Math.hypot(dx, dy, dz) || 1e-3;
          const f = ((d - REF_REST) / d) * 0.5;
          a.pos.x += dx * f; a.pos.y += dy * f; a.pos.z += dz * f;
          t.pos.x -= dx * f; t.pos.y -= dy * f; t.pos.z -= dz * f;
        }
      }
    }
    // Normalise so the whole disc fits a predictable radius.
    let maxR = 1;
    for (const n of nodes) maxR = Math.max(maxR, n.pos.length());
    const s = GAL_R / maxR;
    for (const n of nodes) n.pos.multiplyScalar(s);
  } else {
    // Loose spherical shell.
    for (const n of nodes) {
      const r = R_MIN + (R_MAX - R_MIN) * Math.cbrt(Math.random());
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      n.pos.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      );
    }
  }

  // --- three.js scene -----------------------------------------------------
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, width / height, 0.1, 4000);
  camera.rotation.order = "YXZ";
  let yaw = 0;
  let pitch = 0;
  const VIEW_R = galaxy ? GAL_R : R_MAX;
  const DIST_MAX = VIEW_R * 3;
  let dist = VIEW_R * 1.7; // backed out enough to see everything
  const forward = new THREE.Vector3();
  // Pan offset (the world point the camera centres on); shift / middle-drag.
  const pan = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const camUp = new THREE.Vector3();

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.domElement.className = "dokki-graph-canvas";
  container.appendChild(renderer.domElement);

  // tilt holds the fixed disc tilt; field spins inside it (galaxy rotation).
  const tilt = new THREE.Group();
  tilt.rotation.x = galaxy ? GALAXY_TILT : 0;
  scene.add(tilt);
  const field = new THREE.Group();
  tilt.add(field);

  // Stars — one additive sprite each.
  const starTex = makeStarTexture();
  const sprites: THREE.Sprite[] = nodes.map((n) => {
    const mat = new THREE.SpriteMaterial({
      map: starTex,
      color: starColorFor(n.filePath),
      transparent: true,
      opacity: baseOpacity(n.rating),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    const sz = starSize(n.rating);
    sp.scale.set(sz, sz, 1);
    sp.position.copy(n.pos);
    sp.userData.node = n;
    field.add(sp);
    return sp;
  });

  // --- hover label (HTML overlay) ----------------------------------------
  const label = document.createElement("div");
  label.className = "dokki-graph-label";
  label.style.display = "none";
  container.appendChild(label);

  // --- highlight state ----------------------------------------------------
  let highlight: Set<string> | null = null;
  let hoverId: string | null = null;
  const idIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const isLit = (id: string) => !highlight || highlight.size === 0 || highlight.has(id);

  function applyNodeStyle(i: number) {
    if (i < 0) return;
    const n = nodes[i];
    const sp = sprites[i];
    const lit = isLit(n.id);
    const hovered = hoverId === n.id;
    const mat = sp.material as THREE.SpriteMaterial;
    mat.opacity = lit ? Math.min(1, baseOpacity(n.rating) * (hovered ? 1.2 : 1)) : DIM_NODE;
    const sz = starSize(n.rating) * (hovered && lit ? 1.35 : 1);
    sp.scale.set(sz, sz, 1);
  }

  const setHighlight = (ids: Set<string> | null): void => {
    highlight = ids;
    for (let i = 0; i < nodes.length; i++) applyNodeStyle(i);
  };

  // --- pointer interaction (raycast pick / pull / look-around / zoom) -----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const dragPlane = new THREE.Plane();
  const hitWorld = new THREE.Vector3();

  let dragging = false; // turning the view (empty-space drag)
  let panningView = false; // shift / middle-button drag → pan the view
  let dragNode: StarNode | null = null; // pulling a star (Obsidian-style)
  let tapNode: StarNode | null = null;
  let settleUntil = 0; // keep the springs running briefly after release
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let moved = false;

  // Soft springs let neighbours trail a pulled note. They run only while a
  // drag is active (plus a short settle), so the idle layout stays put.
  const REST = galaxy ? 90 : 130;
  const STIFF = 0.08;

  function setPointer(e: PointerEvent) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  function pickNode(): StarNode | null {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(sprites, false);
    return hits.length ? (hits[0].object.userData.node as StarNode) : null;
  }

  /** Cursor position projected onto the plane (facing camera) through `at`. */
  function cursorOnPlaneThrough(at: THREE.Vector3): THREE.Vector3 | null {
    dragPlane.setFromNormalAndCoplanarPoint(forward, at);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.ray.intersectPlane(dragPlane, hitWorld);
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) return; // leave right-click alone
    setPointer(e);
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    moved = false;
    if (e.button === 1 || e.shiftKey) {
      // Shift / middle-button → pan the whole view.
      e.preventDefault();
      panningView = true;
    } else {
      const node = pickNode();
      tapNode = node;
      if (node) dragNode = node; // grab the star
      else dragging = true; // empty space → turn the view
    }
    label.style.display = "none";
    renderer.domElement.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    setPointer(e);
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;

    if (panningView) {
      // Slide the centre point along the camera's right/up axes.
      const k = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / height;
      camRight.set(1, 0, 0).applyEuler(camera.rotation);
      camUp.set(0, 1, 0).applyEuler(camera.rotation);
      pan.addScaledVector(camRight, -(e.clientX - lastX) * k);
      pan.addScaledVector(camUp, (e.clientY - lastY) * k);
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
    if (dragNode) {
      // Pull the star: project the cursor onto the plane through it, then
      // store the result in the field's local space (the field is rotating).
      const at = field.localToWorld(dragNode.pos.clone());
      const p = cursorOnPlaneThrough(at);
      if (p) field.worldToLocal(p);
      if (p) dragNode.pos.copy(p);
      return;
    }
    if (dragging) {
      yaw -= (e.clientX - lastX) * 0.005;
      pitch = Math.max(-1.3, Math.min(1.3, pitch - (e.clientY - lastY) * 0.005));
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }

    // Plain hover → label + glow bump.
    const node = pickNode();
    const id = node && isLit(node.id) ? node.id : null;
    if (id !== hoverId) {
      const prev = hoverId;
      hoverId = id;
      if (prev) applyNodeStyle(idIndex.get(prev) ?? -1);
      if (id) applyNodeStyle(idIndex.get(id) ?? -1);
    }
    if (node && id) {
      label.textContent = node.title;
      label.style.display = "block";
      const r = renderer.domElement.getBoundingClientRect();
      label.style.left = `${e.clientX - r.left + 10}px`;
      label.style.top = `${e.clientY - r.top - 6}px`;
      renderer.domElement.style.cursor = "pointer";
    } else {
      label.style.display = "none";
      renderer.domElement.style.cursor = "grab";
    }
  };

  const endPointer = (e: PointerEvent) => {
    if (!moved && tapNode) onOpen(tapNode.filePath);
    if (dragNode) settleUntil = performance.now() + 1100;
    tapNode = null;
    dragNode = null;
    dragging = false;
    panningView = false;
    try {
      renderer.domElement.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    dist = Math.min(DIST_MAX, Math.max(0, dist + e.deltaY * 0.6));
  };

  const cv = renderer.domElement;
  cv.style.cursor = "grab";
  cv.addEventListener("pointerdown", onPointerDown);
  cv.addEventListener("pointermove", onPointerMove);
  cv.addEventListener("pointerup", endPointer);
  cv.addEventListener("pointercancel", endPointer);
  cv.addEventListener("wheel", onWheel, { passive: false });

  // --- per-frame ----------------------------------------------------------
  function syncStars() {
    for (let i = 0; i < nodes.length; i++) sprites[i].position.copy(nodes[i].pos);
  }

  // One gentle spring pass: each link tugs its endpoints toward REST length,
  // the pulled node stays pinned — so neighbours trail it elastically.
  function relax() {
    for (const { s, t, ref } of links) {
      const dx = t.pos.x - s.pos.x;
      const dy = t.pos.y - s.pos.y;
      const dz = t.pos.z - s.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-3) continue;
      // Referenced pairs hold a much tighter rest length than author/tag ones.
      const rest = ref ? 24 : REST;
      const f = ((d - rest) / d) * STIFF * 0.5;
      if (s !== dragNode) {
        s.pos.x += dx * f;
        s.pos.y += dy * f;
        s.pos.z += dz * f;
      }
      if (t !== dragNode) {
        t.pos.x -= dx * f;
        t.pos.y -= dy * f;
        t.pos.z -= dz * f;
      }
    }
  }

  let raf = 0;
  let lastT = performance.now();
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    field.rotation.y += dt * (galaxy ? 0.045 : 0.05);
    if (!galaxy) field.rotation.x += dt * 0.012;
    if (dragNode || now < settleUntil) relax();
    syncStars();
    // Face direction D (yaw/pitch); sit at -D*dist so the origin — and thus
    // the whole field — stays centred ahead, however far we back out.
    camera.rotation.set(pitch, yaw, 0);
    forward.set(0, 0, -1).applyEuler(camera.rotation);
    // Centre on `pan`, sitting -dist behind it along the view axis.
    camera.position.copy(pan).addScaledVector(forward, -dist);
    renderer.render(scene, camera);
  };
  tick();

  const ro = new ResizeObserver(() => {
    width = container.clientWidth || width;
    height = container.clientHeight || height;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  });
  ro.observe(container);

  return {
    cleanup: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.removeEventListener("pointerdown", onPointerDown);
      cv.removeEventListener("pointermove", onPointerMove);
      cv.removeEventListener("pointerup", endPointer);
      cv.removeEventListener("pointercancel", endPointer);
      cv.removeEventListener("wheel", onWheel);
      label.remove();
      sprites.forEach((s) => (s.material as THREE.SpriteMaterial).dispose());
      starTex.dispose();
      renderer.forceContextLoss();
      renderer.dispose();
      cv.remove();
    },
    setHighlight,
    recolor: () => {
      for (let i = 0; i < nodes.length; i++) {
        (sprites[i].material as THREE.SpriteMaterial).color.copy(starColorFor(nodes[i].filePath));
      }
    },
  };
}
