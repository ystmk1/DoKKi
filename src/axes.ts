// 3D 큐브 뷰의 좌표계 — 세 축, 여섯 극단.
//
// 각 축은 서로 반대되는 "극단의 기준" 한 쌍으로 정의된다. 노트의 태그(KDC
// 오버레이 포함)·제목·본문에서 각 극의 어휘가 얼마나 나타나는지를 세어
// [-1, 1] 좌표로 정규화하고, 큐브 안의 위치가 곧 그 책의 성격이 되도록 한다.
// 비슷한 책은 자연히 같은 팔분면(octant)에 모여 연관성이 "위치"로 읽힌다.
//
// 신호가 전혀 없는 축은 0(중앙) 근처에 머문다 — 중앙 = 미분류라는 뜻이
// 그대로 성립한다. 파일 경로 해시로 소량의 지터를 더해 같은 점수의 노트가
// 한 점에 겹치지 않게 하되, 렌더마다 위치가 흔들리지 않도록 결정적으로 만든다.

import { BookNote } from "./types";
import { effectiveTags } from "./note-metadata";

export interface AxisDef {
  key: "x" | "y" | "z";
  /** −1 극단의 이름 (예: 이성) */
  neg: string;
  /** +1 극단의 이름 (예: 감성) */
  pos: string;
  negWords: string[];
  posWords: string[];
}

// 어휘는 태그·제목·본문 어디서든 부분 일치로 집계된다. 필요하면 여기만
// 고쳐서 축의 성격 자체를 바꿀 수 있다 (예: 고전↔현대, 짧음↔김 …).
export const AXES: AxisDef[] = [
  {
    key: "x",
    neg: "이성",
    pos: "감성",
    negWords: [
      "철학", "과학", "사회과학", "비평", "평론", "논리", "사상", "이론",
      "경제", "정치", "역사", "심리학", "인지", "수학", "기술", "지식",
      "분석", "연구", "논픽션", "인문",
    ],
    posWords: [
      "시", "서정", "에세이", "산문", "수필", "사랑", "연애", "로맨스",
      "감정", "위로", "그리움", "슬픔", "고독", "마음", "낭만", "청춘",
    ],
  },
  {
    key: "y",
    neg: "개인",
    pos: "세계",
    negWords: [
      "일기", "자전", "회고", "고백", "성장", "내면", "자아", "일상",
      "가족", "관계", "심리", "정체성", "치유", "몸", "기억",
    ],
    posWords: [
      "사회", "역사", "정치", "전쟁", "혁명", "공동체", "세계", "문명",
      "도시", "국가", "계급", "노동", "자본", "권력", "제국", "민족",
    ],
  },
  {
    key: "z",
    neg: "현실",
    pos: "상상",
    negWords: [
      "르포", "다큐", "사실", "리얼리즘", "현실", "논픽션", "기록",
      "취재", "실화", "현장", "사회파",
    ],
    posWords: [
      "판타지", "sf", "과학소설", "환상", "신화", "우화", "초현실",
      "마술적", "꿈", "괴담", "미래", "디스토피아", "유토피아", "동화",
    ],
  },
];

export interface CubePos {
  x: number;
  y: number;
  z: number;
  /** 세 축 모두 신호가 없어 중앙 지터만 남은 노트 (시각적으로 흐리게). */
  unclassified: boolean;
}

/** 노트 하나를 큐브 좌표로. 각 성분은 [-1, 1]. */
export function scoreNote(b: BookNote): CubePos {
  const tags = effectiveTags(b).map((t) => t.toLowerCase());
  const title = b.title.toLowerCase();
  // 본문은 앞부분만 샘플링 — 어휘 빈도의 "경향"만 필요하고, 전체 스캔은
  // 긴 노트에서 낭비다.
  const body = [b.externalQuote ?? "", ...b.pages.map((p) => p.body)]
    .join("\n")
    .toLowerCase()
    .slice(0, 4000);

  let anySignal = false;
  const out = { x: 0, y: 0, z: 0 };
  for (const axis of AXES) {
    const neg = poleScore(axis.negWords, tags, title, body);
    const pos = poleScore(axis.posWords, tags, title, body);
    let v = 0;
    if (neg + pos > 0) {
      anySignal = true;
      v = (pos - neg) / (pos + neg); // [-1, 1], 신호 비율
      v *= 0.85; // 극단에 완전히 붙지 않게 살짝 안쪽으로
    }
    // 결정적 지터: 같은 점수의 노트가 정확히 겹치지 않게, 그러나 렌더마다
    // 같은 자리에 있게.
    v += hashJitter(`${b.filePath}|${axis.key}`) * 0.1;
    out[axis.key] = Math.max(-0.97, Math.min(0.97, v));
  }
  return { ...out, unclassified: !anySignal };
}

/** 한 극의 어휘가 태그(×3)·제목(×2)·본문(×1, 최대 3회)에 나타난 가중 합. */
function poleScore(words: string[], tags: string[], title: string, body: string): number {
  let score = 0;
  for (const w of words) {
    // 한 글자 어휘("시" 등)는 오탐이 많아 태그 완전 일치만 인정한다.
    if (w.length === 1) {
      if (tags.some((t) => t === w || t.split("/").includes(w))) score += 3;
      continue;
    }
    for (const t of tags) if (t.includes(w)) score += 3;
    if (title.includes(w)) score += 2;
    let idx = -1;
    let n = 0;
    while (n < 3 && (idx = body.indexOf(w, idx + 1)) !== -1) n++;
    score += n;
  }
  return score;
}

/** 문자열 → [-1, 1] 결정적 의사난수 (FNV-1a). */
function hashJitter(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}
