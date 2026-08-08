// 3D 큐브 뷰 — 노트를 세 축(이성↔감성 · 개인↔세계 · 현실↔상상)의 좌표로
// 배치해, 책 사이의 연관성이 "거리"로 읽히는 사분면(팔분면) 지도.
//
// 은하 뷰(graphView)와 같은 GraphHandle 인터페이스를 구현하므로 view-web은
// 렌더러만 바꿔 끼우면 된다. 시각은 레퍼런스(얇은 와이어프레임 + 점 + 얇은
// 연결선)를 따라 사이트의 종이 배경 위에 그대로 앉는 라이트 룩이 기본이고,
// 다크 모드에서는 잉크/종이만 반전된다.

import * as THREE from "three";
import { BookNote, GraphBasis } from "./types";
import { buildGraph } from "./graph";
import { getMetadata } from "./note-metadata";
import { scoreNote, AXES } from "./axes";
import type { GraphHandle } from "./graphView";

const HEIGHT = 340;
const HALF = 150; // 큐브 반변 (월드 단위)
const DIM_NODE = 0.1;

interface CubeNode {
  id: string;
  title: string;
  filePath: string;
  rating: number;
  unclassified: boolean;
  pos: THREE.Vector3;
}

interface Palette {
  ink: THREE.Color; // 기본 점/글자
  muted: string; // 축 라벨
  edge: THREE.Color; // 큐브 모서리/격자
  isDark: boolean;
}

function palette(): Palette {
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return isDark
    ? {
        ink: new THREE.Color("#e4e2dd"),
        muted: "#8a8884",
        edge: new THREE.Color("#8a8884"),
        isDark,
      }
    : {
        ink: new THREE.Color("#1a1a1a"),
        muted: "#6b6b66",
        edge: new THREE.Color("#1a1a1a"),
        isDark,
      };
}

/** 표지 색 → 종이/잉크 배경 위에서 읽히는 점 색. */
function coverDotColor(filePath: string, pal: Palette): THREE.Color | null {
  const raw = getMetadata(filePath)?.coverColor;
  if (!raw) return null;
  const p = raw.split(",").map((n) => parseFloat(n) / 255);
  if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null;
  const c = new THREE.Color(p[0], p[1], p[2]);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  // 라이트 배경에선 어둡고 진하게, 다크 배경에선 밝게 — 채도는 살려서
  // 레퍼런스의 원색 점 느낌을 유지한다.
  const l = pal.isDark
    ? Math.max(0.55, Math.min(0.7, hsl.l))
    : Math.max(0.32, Math.min(0.5, hsl.l));
  c.setHSL(hsl.h, Math.min(1, hsl.s * 1.5 + 0.15), l);
  return c;
}

/** 흐린 외곽의 원형 점 텍스처. */
function makeDotTexture(): THREE.Texture {
  const s = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.72, "rgba(255,255,255,1)");
  g.addColorStop(0.86, "rgba(255,255,255,0.4)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 축 극단 라벨(한글) 텍스트 스프라이트. */
function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const dpr = 2;
  const fontPx = 22 * dpr;
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d")!;
  const font = `500 ${fontPx}px "Pretendard Variable", Pretendard, "Apple SD Gothic Neo", sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 8 * dpr;
  const h = fontPx + 8 * dpr;
  cv.width = w;
  cv.height = h;
  const c2 = cv.getContext("2d")!;
  c2.font = font;
  c2.textAlign = "center";
  c2.textBaseline = "middle";
  c2.fillStyle = color;
  c2.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  const scale = 0.42; // 월드 단위로 보기 좋은 크기
  sp.scale.set((w / dpr) * scale, (h / dpr) * scale, 1);
  return sp;
}

export function renderCube(
  container: HTMLElement,
  books: BookNote[],
  onOpen: (path: string) => void,
  basis: GraphBasis = "both",
): GraphHandle {
  const pal = palette();
  const { links: rawLinks } = buildGraph(books, basis);

  // 크기는 컨테이너(CSS)가 결정한다 — 와이드 2열 레이아웃에선 화면을 채운다.
  let width = container.clientWidth || 800;
  let height = container.clientHeight || HEIGHT;
  container.style.position = "relative";

  // --- 노드: 축 점수 → 큐브 좌표 -----------------------------------------
  const nodes: CubeNode[] = books.map((b) => {
    const s = scoreNote(b);
    return {
      id: b.filePath,
      title: b.title,
      filePath: b.filePath,
      rating: b.frontmatter.rating ?? 0,
      unclassified: s.unclassified,
      pos: new THREE.Vector3(s.x * HALF, s.y * HALF, s.z * HALF),
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = rawLinks
    .map((l) => ({
      s: byId.get(l.source as string),
      t: byId.get(l.target as string),
      ref: l.basis === "ref",
    }))
    .filter((l): l is { s: CubeNode; t: CubeNode; ref: boolean } => !!l.s && !!l.t);

  // --- three.js 장면 ------------------------------------------------------
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 4000);
  camera.rotation.order = "YXZ";
  // 레퍼런스처럼 위에서 비스듬히 내려다보는 아이소메트릭 느낌의 초기 각.
  let yaw = 0.62;
  let pitch = -0.46;
  // 카메라 거리는 "큐브 전체(코너·라벨 포함)가 항상 화면에 다 들어오는" 값을
  // 캔버스 비율에서 역산한다 — 어떤 크기의 캔버스에서도 잘리지 않는다.
  // 휠 줌은 그 기준 거리에 대한 배율로만 동작한다.
  const FIT_R = HALF * Math.sqrt(3) * 1.16; // 코너 반경 + 라벨 여유
  let zoom = 1;
  const fitDist = () => {
    const vHalf = (camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    return FIT_R / Math.sin(Math.min(vHalf, hHalf));
  };
  const forward = new THREE.Vector3();

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.domElement.className = "dokki-graph-canvas";
  container.appendChild(renderer.domElement);

  const field = new THREE.Group(); // 자동 회전은 이 그룹이 담당
  scene.add(field);

  // --- 큐브 프레임 ---------------------------------------------------------
  const disposables: Array<{ dispose: () => void }> = [];
  const edgeMat = new THREE.LineBasicMaterial({
    color: pal.edge,
    transparent: true,
    opacity: pal.isDark ? 0.45 : 0.3,
  });
  const boxGeom = new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2);
  const edgesGeom = new THREE.EdgesGeometry(boxGeom);
  boxGeom.dispose();
  field.add(new THREE.LineSegments(edgesGeom, edgeMat));
  disposables.push(edgesGeom, edgeMat);

  // 중앙 십자 평면(사분면 경계) — 아주 흐리게. 축마다 0면의 정사각 외곽선.
  const midMat = new THREE.LineBasicMaterial({
    color: pal.edge,
    transparent: true,
    opacity: pal.isDark ? 0.16 : 0.1,
  });
  disposables.push(midMat);
  const H = HALF;
  const midPlanes: THREE.Vector3[][] = [
    // x = 0 평면
    [new THREE.Vector3(0, -H, -H), new THREE.Vector3(0, H, -H), new THREE.Vector3(0, H, H), new THREE.Vector3(0, -H, H)],
    // y = 0 평면
    [new THREE.Vector3(-H, 0, -H), new THREE.Vector3(H, 0, -H), new THREE.Vector3(H, 0, H), new THREE.Vector3(-H, 0, H)],
    // z = 0 평면
    [new THREE.Vector3(-H, -H, 0), new THREE.Vector3(H, -H, 0), new THREE.Vector3(H, H, 0), new THREE.Vector3(-H, H, 0)],
  ];
  for (const pts of midPlanes) {
    const g = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]);
    field.add(new THREE.Line(g, midMat));
    disposables.push(g);
  }

  // 축 극단 라벨 — 각 면 중앙 바깥쪽에.
  const LABEL_OUT = H + 26;
  const labelPos: Record<string, [THREE.Vector3, THREE.Vector3]> = {
    x: [new THREE.Vector3(-LABEL_OUT, 0, 0), new THREE.Vector3(LABEL_OUT, 0, 0)],
    y: [new THREE.Vector3(0, -LABEL_OUT, 0), new THREE.Vector3(0, LABEL_OUT, 0)],
    z: [new THREE.Vector3(0, 0, -LABEL_OUT), new THREE.Vector3(0, 0, LABEL_OUT)],
  };
  for (const axis of AXES) {
    const [negP, posP] = labelPos[axis.key];
    const negSp = makeLabelSprite(axis.neg, pal.muted);
    negSp.position.copy(negP);
    const posSp = makeLabelSprite(axis.pos, pal.muted);
    posSp.position.copy(posP);
    field.add(negSp, posSp);
    disposables.push(negSp.material.map!, negSp.material, posSp.material.map!, posSp.material);
  }

  // --- 연결선 --------------------------------------------------------------
  // 위치가 관계를 이미 말하므로 선은 보조 — 얇고 흐리게, 명시적 [[참조]]만
  // 조금 더 진하게. (하이라이트 시에는 점만 디밍한다 — 은하 뷰와 동일.)
  function lineSegments(pairs: Array<{ s: CubeNode; t: CubeNode }>, opacity: number) {
    if (!pairs.length) return null;
    const posArr = new Float32Array(pairs.length * 6);
    pairs.forEach((l, i) => {
      posArr.set([l.s.pos.x, l.s.pos.y, l.s.pos.z, l.t.pos.x, l.t.pos.y, l.t.pos.z], i * 6);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    const m = new THREE.LineBasicMaterial({ color: pal.edge, transparent: true, opacity });
    disposables.push(g, m);
    const seg = new THREE.LineSegments(g, m);
    field.add(seg);
    return seg;
  }
  lineSegments(links.filter((l) => !l.ref), pal.isDark ? 0.14 : 0.09);
  lineSegments(links.filter((l) => l.ref), pal.isDark ? 0.42 : 0.3);

  // --- 점(노트) ------------------------------------------------------------
  const dotTex = makeDotTexture();
  disposables.push(dotTex);
  const dotColorFor = (n: CubeNode) => coverDotColor(n.filePath, pal) ?? pal.ink.clone();
  const dotSize = (n: CubeNode) => 7 + 1.8 * (n.rating > 0 ? Math.min(1, (n.rating - 1) / 4) : 0);
  const baseOpacity = (n: CubeNode) => (n.unclassified ? 0.4 : 0.92);

  const sprites: THREE.Sprite[] = nodes.map((n) => {
    const mat = new THREE.SpriteMaterial({
      map: dotTex,
      color: dotColorFor(n),
      transparent: true,
      opacity: baseOpacity(n),
      depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    const sz = dotSize(n);
    sp.scale.set(sz, sz, 1);
    sp.position.copy(n.pos);
    sp.userData.node = n;
    field.add(sp);
    disposables.push(mat);
    return sp;
  });

  // --- 호버 라벨 -----------------------------------------------------------
  const label = document.createElement("div");
  label.className = "dokki-graph-label";
  label.style.display = "none";
  container.appendChild(label);

  // --- 하이라이트 ----------------------------------------------------------
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
    (sp.material as THREE.SpriteMaterial).opacity = lit
      ? Math.min(1, baseOpacity(n) * (hovered ? 1.2 : 1))
      : DIM_NODE;
    const sz = dotSize(n) * (hovered && lit ? 1.4 : 1);
    sp.scale.set(sz, sz, 1);
  }

  const setHighlight = (ids: Set<string> | null): void => {
    highlight = ids;
    for (let i = 0; i < nodes.length; i++) applyNodeStyle(i);
  };

  // --- 포인터 (회전 / 줌 / 픽) --------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let dragging = false;
  let tapNode: CubeNode | null = null;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let moved = false;

  function setPointer(e: PointerEvent) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  function pickNode(): CubeNode | null {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(sprites, false);
    for (const h of hits) {
      const n = h.object.userData.node as CubeNode | undefined;
      if (n) return n;
    }
    return null;
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) return;
    setPointer(e);
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    moved = false;
    tapNode = pickNode();
    dragging = true;
    label.style.display = "none";
    renderer.domElement.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    setPointer(e);
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;
    if (dragging) {
      yaw -= (e.clientX - lastX) * 0.005;
      pitch = Math.max(-1.3, Math.min(1.3, pitch - (e.clientY - lastY) * 0.005));
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
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
    tapNode = null;
    dragging = false;
    try {
      renderer.domElement.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoom = Math.min(2.6, Math.max(0.45, zoom * Math.exp(e.deltaY * 0.001)));
  };

  const cv = renderer.domElement;
  cv.style.cursor = "grab";
  cv.addEventListener("pointerdown", onPointerDown);
  cv.addEventListener("pointermove", onPointerMove);
  cv.addEventListener("pointerup", endPointer);
  cv.addEventListener("pointercancel", endPointer);
  cv.addEventListener("wheel", onWheel, { passive: false });

  // --- 프레임 루프 ---------------------------------------------------------
  let raf = 0;
  let lastT = performance.now();
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (!dragging) field.rotation.y += dt * 0.05; // 손을 대면 멈추는 느린 자전
    camera.rotation.set(pitch, yaw, 0);
    forward.set(0, 0, -1).applyEuler(camera.rotation);
    camera.position.copy(forward).multiplyScalar(-fitDist() * zoom);
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
      for (const d of disposables) d.dispose();
      renderer.forceContextLoss();
      renderer.dispose();
      cv.remove();
    },
    setHighlight,
    recolor: () => {
      for (let i = 0; i < nodes.length; i++) {
        (sprites[i].material as THREE.SpriteMaterial).color.copy(dotColorFor(nodes[i]));
      }
    },
  };
}
