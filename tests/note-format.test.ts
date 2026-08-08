// 골든 픽스처 회귀 테스트 + 속성 테스트 — plan.md의 P1.
//
// 픽스처 규약: tests/fixtures/normalize/<이름>/input.txt → expected.txt.
// <이름>이 "scan-"으로 시작하면 스캔 모드(preserveSkips: false)로 돌린다.
//
// 새 양식 버그를 발견하면: ① 여기에 픽스처부터 추가(red) → ② 규칙 수정(green)
// → ③ 전체 통과 확인. 규칙을 먼저 고치지 말 것.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeNoteFormat, isStandaloneDialogue } from "../lib/note-format";

const FIXTURE_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "normalize");
const fixtures = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const read = (name: string, file: string) =>
  readFileSync(join(FIXTURE_ROOT, name, file), "utf8").replace(/\r\n/g, "\n");

const optsFor = (name: string) => ({ preserveSkips: !name.startsWith("scan-") });

describe("골든 픽스처", () => {
  for (const name of fixtures) {
    it(name, () => {
      const input = read(name, "input.txt");
      const expected = read(name, "expected.txt").replace(/\n+$/, "");
      expect(normalizeNoteFormat(input, optsFor(name))).toBe(expected);
    });
  }
});

describe("속성: 멱등성 — normalize(normalize(x)) === normalize(x)", () => {
  for (const name of fixtures) {
    it(name, () => {
      const once = normalizeNoteFormat(read(name, "input.txt"), optsFor(name));
      expect(normalizeNoteFormat(once, optsFor(name))).toBe(once);
    });
  }
});

describe("속성: 내용 보존 — 공백·마커 외의 글자를 만들거나 지우지 않는다", () => {
  // 페이지 마커 줄(쪽→p. 표기 변환 허용)과 공백·`*`(볼드 짝 보충 허용)를
  // 제외한 나머지 글자는 입력과 출력이 동일해야 한다.
  const core = (text: string) =>
    text
      .split("\n")
      .filter((l) => !/^#{5}/.test(l.trim()))
      .join("")
      .replace(/[\s*]/g, "");
  for (const name of fixtures) {
    it(name, () => {
      const input = read(name, "input.txt");
      const output = normalizeNoteFormat(input, optsFor(name));
      expect(core(output)).toBe(core(input));
    });
  }
});

describe("독립 대사 판정", () => {
  it.each([
    ["“가지 마.”", true],
    ["“가지 마”", true],
    ["“정말?”", true],
    ["「그래」", true],
    ["“가지 마,” 하고 그가 말했다.", false], // 지문 섞임
    ["그가 “가지 마”라고 말했다.", false], // 지문 속 인용
    ["평범한 지문이다.", false],
    ["“", false],
  ])("%s → %s", (line, want) => {
    expect(isStandaloneDialogue(line as string)).toBe(want);
  });
});
