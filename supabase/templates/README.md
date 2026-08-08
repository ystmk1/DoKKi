# 이메일 템플릿 설정

`magic-link.html`은 이메일 로그인(매직 링크) 메일의 HTML 템플릿입니다.
사이트 코드는 `supabase.auth.signInWithOtp({ email })`로 링크 발송을 요청하고,
실제 메일 본문은 Supabase가 이 템플릿으로 렌더링해 보냅니다.

## 적용 방법 (1회)

1. [Supabase Dashboard](https://supabase.com/dashboard) → 프로젝트 선택
2. **Authentication → Email Templates → Magic Link** 탭
3. Subject를 `tin 로그인 링크` 등으로 수정
4. Message body(HTML)에 `magic-link.html` 내용 전체를 붙여넣고 저장

`{{ .ConfirmationURL }}` 자리는 발송 시 Supabase가 실제 로그인 링크로 치환합니다.

## 참고

- **Authentication → Providers → Email**이 켜져 있어야 합니다(기본 on).
  "Confirm email" 여부와 무관하게 magic link는 동작합니다.
- 새 이메일 주소로 요청하면 계정이 자동 생성됩니다(초대 링크처럼 동작).
  이를 막으려면 `auth.ts`의 `shouldCreateUser`를 `false`로 바꾸세요.
- 기본 SMTP는 시간당 발송 제한이 낮습니다(테스트용). 실서비스는
  **Project Settings → Auth → SMTP Settings**에 커스텀 SMTP(Resend, SES 등)를 연결하세요.
- 로그인 링크의 리다이렉트 대상(`window.location.origin`)이
  **Authentication → URL Configuration → Redirect URLs**에 등록되어 있어야 합니다.
  (예: `http://localhost:5173`, 배포 도메인)
