// 렌더 관용 층 테스트 — 노트 원문의 흔한 양식 미스가 웹 뷰에서 올바른
// 구조(HTML)로 흡수되는지 검증한다. docs/FORMAT.md의 "렌더 관용" 층.

import { describe, it, expect } from "vitest";
import { renderBodyHTML } from "../src/render-body";

describe("부제목", () => {
  it("정상 부제목 → span", () => {
    expect(renderBodyHTML("### 어린 시절")).toBe(
      '<span class="dokki-subheading">어린 시절</span>',
    );
  });

  it("공백 누락(##제목)도 부제목으로 관용 해석", () => {
    expect(renderBodyHTML("##어린 시절")).toBe(
      '<span class="dokki-subheading">어린 시절</span>',
    );
  });

  it("부제목·본문 사이 빈 줄 유무와 무관하게 같은 구조(간격은 CSS 소유)", () => {
    const glued = renderBodyHTML("### 제목\n본문이다.");
    const spaced = renderBodyHTML("### 제목\n\n\n본문이다.");
    expect(glued).toBe(spaced);
  });

  it("페이지 마커(5개 해시)는 부제목으로 읽지 않음", () => {
    expect(renderBodyHTML("##### 12p.")).not.toContain("dokki-subheading");
  });
});

describe("볼드·인용", () => {
  it("여러 줄 볼드 + 내부 이탤릭", () => {
    expect(renderBodyHTML("**굵게 *속기울임* 끝**")).toBe(
      "<strong>굵게 <em>속기울임</em> 끝</strong>",
    );
  });

  it("> 인용 연속 줄은 한 박스로", () => {
    const html = renderBodyHTML("> 첫 줄\n> 둘째 줄");
    expect(html.match(/dokki-blockquote/g)?.length).toBe(1);
    expect(html).toContain("첫 줄\n둘째 줄");
  });
});

describe("스킵·이미지", () => {
  it("빈 줄 2개 이상 → 의도적 스킵 span", () => {
    expect(renderBodyHTML("가\n\n\n나")).toContain("dokki-skip");
  });

  it("이미지는 제거", () => {
    expect(renderBodyHTML("![alt](https://x/y.png)")).toBe("");
    expect(renderBodyHTML("![[사진.png]]")).toBe("");
  });
});
