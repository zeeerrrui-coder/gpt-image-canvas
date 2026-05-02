import {
  ArrowRight,
  CheckCircle2,
  ImageIcon,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
  Terminal
} from "lucide-react";
import type { AuthStatusResponse } from "@gpt-image-canvas/shared";
import productPreviewUrl from "../../../docs/assets/app-preview.png";

interface HomePageProps {
  authError: string;
  authStatus: AuthStatusResponse | null;
  isAuthLoading: boolean;
  isCodexStarting: boolean;
  onOpenProviderConfig: () => void;
  onOpenGallery: () => void;
  onStartCodexLogin: () => void;
}

export function HomePage({
  authError,
  authStatus,
  isAuthLoading,
  isCodexStarting,
  onOpenProviderConfig,
  onOpenGallery,
  onStartCodexLogin
}: HomePageProps) {
  const providerLabel =
    authStatus?.provider === "openai" ? "OpenAI API 已接入" : authStatus?.provider === "codex" ? "Codex 会话已可用" : "等待接入生成服务";

  return (
    <main className="home-page app-view" data-testid="home-page">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero__visual" aria-hidden="true">
          <img className="home-preview-image" src={productPreviewUrl} alt="" />
        </div>

        <div className="home-hero__copy">
          <p className="home-kicker">
            <Sparkles className="size-4" aria-hidden="true" />
            专业 AI 画布
          </p>
          <h1 id="home-title">专业 AI 画布</h1>
          <p className="home-deck">把提示词、参考图、生成历史和视觉比较收束到一张本地画布里。</p>

          <div className="home-actions" aria-label="进入方式">
            <button
              className="home-action home-action--primary"
              data-testid="home-codex-login"
              disabled={isAuthLoading || isCodexStarting}
              type="button"
              onClick={onStartCodexLogin}
            >
              {isCodexStarting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <KeyRound className="size-4" aria-hidden="true" />}
              Codex 登录
            </button>
            <button className="home-action home-action--secondary" data-testid="home-api-setup" type="button" onClick={onOpenProviderConfig}>
              <Terminal className="size-4" aria-hidden="true" />
              接入 API
            </button>
          </div>

          <div className="home-provider-state" data-provider={authStatus?.provider ?? "loading"} data-testid="home-provider-state">
            <span className="home-provider-state__icon">
              {isAuthLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : authStatus?.provider === "none" || !authStatus ? (
                <KeyRound className="size-4" aria-hidden="true" />
              ) : (
                <ShieldCheck className="size-4" aria-hidden="true" />
              )}
            </span>
            <span>{isAuthLoading ? "正在检查本地凭据" : providerLabel}</span>
          </div>

          {authError ? (
            <p className="home-auth-error" role="alert">
              {authError}
            </p>
          ) : null}
        </div>
      </section>

      <section className="home-afterfold" aria-label="创作入口">
        <div className="home-afterfold__item">
          <span>
            <CheckCircle2 className="size-4" aria-hidden="true" />
          </span>
          <p>API Key 只在服务端环境读取，浏览器不会保存或回显密钥。</p>
        </div>
        <button className="home-gallery-link" data-testid="home-gallery-link" type="button" onClick={onOpenGallery}>
          <ImageIcon className="size-4" aria-hidden="true" />
          打开 Gallery
          <ArrowRight className="size-4" aria-hidden="true" />
        </button>
      </section>
    </main>
  );
}
