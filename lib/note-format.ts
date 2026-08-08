// 결정론적 노트 양식 정규화기 — docs/FORMAT.md의 구현.
//
// 파이프라인의 마지막 층: OCR/reflow/AI(Gemini)가 뭘 내놓든 이 함수가 tin
// 노트 양식을 강제한다. AI 출력의 비결정성은 여기서 흡수된다.
//
// 설계 원칙:
//  - 결정론·멱등: normalize(normalize(x)) === normalize(x). 재실행에 안전.
//  - 내용 보존: 공백/줄바꿈/마커 표기 외의 글자를 만들거나 지우지 않는다.
//    (예외는 FORMAT.md가 명시한 복구 두 가지 — 부제목 공백 보충, 볼드 짝 보충)
//  - 확신 없는 것은 건드리지 않는다. 한글 띄어쓰기 복원 같은 휴리스틱은
//    reflow/AI의 몫이고, 여기는 "형태"만 다룬다.

export interface NormalizeOpts {
  /**
   * true(기본): 빈 줄 2개 이상(의도적 스킵)을 보존 — 노트 원문용.
   * false: 빈 줄 1개로 축약 — 스캔 출력용 (OCR에 의도적 스킵은 없다).
   */
  preserveSkips?: boolean;
}

const OPENERS = "“\"「『‘";
const CLOSERS = "”\"」』’";

// ##### 256 / ##### 256p / ##### 256p. / ##### 256쪽 / #####256p. / ##### -
const PAGE_MARKER_LOOSE = /^#{5}\s*(\d+|-)\s*(?:p\.?|쪽|page)?\s*$/i;
// # ~ #### 부제목 — 공백 누락(`##제목`)도 허용. 5개(페이지 마커)는 제외.
const SUBHEADING_LOOSE = /^(#{1,4})(?!#)[ \t]*(\S.*?)[ \t]*$/;

/** docs/FORMAT.md 양식을 강제한다. 순수 함수. */
export function normalizeNoteFormat(text: string, opts: NormalizeOpts = {}): string {
  const preserveSkips = opts.preserveSkips !== false;
  if (!text) return text;

  // R1 기초: 줄끝 통일, NBSP, 줄 끝 공백 제거.
  let lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""));

  // 줄 단위 1차 변환: 마커/부제목 표준화 + 그 줄의 "블록 여부" 판정.
  // 블록(단독 문단이어야 하는 줄): 페이지 마커, 부제목, 독립 대사.
  const isBlock: boolean[] = new Array(lines.length).fill(false);
  lines = lines.map((line, i) => {
    const t = line.trim();
    if (t === "") return "";

    const pm = t.match(PAGE_MARKER_LOOSE);
    if (pm) {
      isBlock[i] = true;
      return `##### ${pm[1]}p.`; // R4 표준형
    }
    const sub = t.match(SUBHEADING_LOOSE);
    if (sub) {
      isBlock[i] = true;
      return `${sub[1]} ${sub[2]}`; // R5: 공백 보정 (이미 맞으면 그대로)
    }
    if (isStandaloneDialogue(t)) {
      isBlock[i] = true; // R2: 독립 대사
      return normalizeInlineSpaces(t);
    }
    return normalizeInlineSpaces(line.trim() === t ? line : t);
  });

  // 블록 줄 앞뒤에 빈 줄 강제 (R2·R4·R5). 사이 빈 줄 개수는 아래 축약 단계가
  // 정리하므로 여기선 "최소 1개"만 보장한다.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlock[i] && out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push(lines[i]);
    const next = lines[i + 1];
    if (isBlock[i] && next !== undefined && next !== "") out.push("");
  }

  // R1: 빈 줄 정리. preserveSkips면 "빈 줄 2개 이상"을 정확히 2개로 캡하지
  // 않고 그대로 두되(의도적 스킵), 스캔 모드에서는 전부 1개로 축약.
  let result = out.join("\n");
  result = preserveSkips
    ? result.replace(/\n{5,}/g, "\n\n\n\n") // 폭주만 방지 (스킵 최대 2문단 분량)
    : result.replace(/\n{3,}/g, "\n\n");

  // R6: 볼드 한쪽 누락 복구 (문단 단위).
  result = fixStrayBold(result);

  // R1: 문서 가장자리 빈 줄 제거.
  return result.replace(/^\n+/, "").replace(/\n+$/, "");
}

/**
 * R2 독립 대사 판정: 줄이 여는 따옴표로 시작하고, 닫는 따옴표(+선택적 종결
 * 부호)로 끝난다. 문장 중간 인용(지문 속 대사)은 줄 시작이 따옴표가 아니므로
 * 여기 걸리지 않는다.
 */
export function isStandaloneDialogue(line: string): boolean {
  const t = line.trim();
  if (t.length < 2) return false;
  if (!OPENERS.includes(t[0])) return false;
  // 닫는 따옴표 뒤 문장부호 허용: “…….” / “…”? / “…”!
  const m = t.match(/([”"」』’])[.?!…]*$/);
  return m !== null;
}

/** R7: 연속 공백 축약 + 종결부호 앞 공백 제거 (말줄임표는 불변). */
function normalizeInlineSpaces(line: string): string {
  return line
    .replace(/ {2,}/g, " ")
    .replace(/ +([.,!?])(?!\.)/g, "$1"); // " ." → "." (…/... 는 (?!\.)로 보호)
}

/**
 * R6: 문단에 `**`가 정확히 한 번뿐인 실수(볼드 한쪽 누락)를 문단 경계에서
 * 복구한다. parser-core.fixStrayBold와 같은 규칙 — 여기서는 소스 단계에서
 * 고쳐서 저장본 자체가 올바르게 되도록 한다.
 */
export function fixStrayBold(body: string): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }
    let j = i; // 문단 구간 [i, j)
    while (j < lines.length && lines[j].trim() !== "") j++;
    const para = lines.slice(i, j);
    const count = (para.join("\n").match(/\*\*/g) ?? []).length;
    if (count === 1) {
      const startsBold = /^\s*\*\*/.test(para[0]);
      const endsBold = /\*\*\s*$/.test(para[para.length - 1]);
      if (startsBold && !endsBold) lines[j - 1] = lines[j - 1].replace(/\s*$/, "") + "**";
      else if (endsBold && !startsBold) lines[i] = lines[i].replace(/^(\s*)/, "$1**");
    }
    i = j;
  }
  return lines.join("\n");
}
