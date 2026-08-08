// Gemini 모델 자동 감지 회귀 테스트 — "This model only supports Interactions
// API" 사고의 재발 방지. 알파벳 역순 정렬이 별칭/신세대 모델을 뽑던 버그를
// 버전 기반 랭킹 + 비호환 폴백으로 고쳤다.

import { describe, it, expect } from "vitest";
import { rankFlashModels, isModelIncompatibleError, callGeminiClean } from "../lib/gemini-clean";

describe("rankFlashModels", () => {
  it("버전 숫자가 높은 안정판 flash가 별칭보다 먼저", () => {
    // 실제 사고 케이스: 알파벳순으로는 gemini-flash-latest가 2.5보다 "최신"
    const ranked = rankFlashModels([
      "models/gemini-flash-latest",
      "models/gemini-2.5-flash",
      "models/gemini-2.0-flash",
    ]);
    expect(ranked[0]).toBe("models/gemini-2.5-flash");
  });

  it("lite·preview 변형은 같은 버전의 본판보다 뒤로", () => {
    const ranked = rankFlashModels([
      "models/gemini-2.5-flash-lite",
      "models/gemini-2.5-flash-preview-0917",
      "models/gemini-2.5-flash",
    ]);
    expect(ranked[0]).toBe("models/gemini-2.5-flash");
  });

  it("더 높은 버전이 이긴다", () => {
    const ranked = rankFlashModels(["models/gemini-2.5-flash", "models/gemini-3.0-flash"]);
    expect(ranked[0]).toBe("models/gemini-3.0-flash");
  });
});

describe("isModelIncompatibleError", () => {
  it.each([
    ["Gemini API 오류: This model only supports Interactions API.", true],
    ["models/x is not found for API version v1beta", true],
    ["generateContent is not supported for this model", true],
    ["Gemini API 한도 도달 (429)", false],
    ["API key not valid. Please pass a valid API key.", false],
  ])("%s → %s", (msg, want) => {
    expect(isModelIncompatibleError(msg as string)).toBe(want);
  });
});

describe("callGeminiClean 폴백", () => {
  const listing = {
    models: [
      { name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
    ],
  };

  it("비호환 모델이면 다음 후보로 폴백해 성공한다", async () => {
    const called: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/models?")) {
        return new Response(JSON.stringify(listing), { status: 200 });
      }
      const model = u.match(/models\/([^:]+):/)?.[1] ?? "?";
      called.push(model);
      // 별칭(un-versioned)은 랭킹상 뒤라서 2.5가 먼저 호출되어야 한다.
      // 여기서는 반대 상황도 검증: 첫 후보가 비호환이라고 답해도 폴백한다.
      if (called.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: "This model only supports Interactions API." } }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "정리된 텍스트" }] } }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    const out = await callGeminiClean({ apiKey: "k", text: "원문", fetchImpl });
    expect(out).toBe("정리된 텍스트");
    expect(called.length).toBe(2); // 첫 후보 실패 → 둘째 후보로 재시도
  });

  it("키 오류는 폴백하지 않고 즉시 던진다", async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/models?")) return new Response(JSON.stringify(listing), { status: 200 });
      return new Response(
        JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }),
        { status: 400 },
      );
    }) as typeof fetch;

    await expect(callGeminiClean({ apiKey: "bad", text: "원문", fetchImpl })).rejects.toThrow(
      /API key not valid/,
    );
  });
});
