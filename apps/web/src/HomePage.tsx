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
import { useI18n } from "./i18n";

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
  const { t } = useI18n();
  const providerLabel =
    authStatus?.provider === "openai" ? t("homeProviderOpenAI") : authStatus?.provider === "codex" ? t("homeProviderCodex") : t("homeProviderNone");

  return (
    <main className="home-page app-view" data-testid="home-page">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero__visual" aria-hidden="true">
          <img className="home-preview-image" src={productPreviewUrl} alt="" />
        </div>

        <div className="home-hero__copy">
          <p className="home-kicker">
            <Sparkles className="size-4" aria-hidden="true" />
            {t("homeKicker")}
          </p>
          <h1 id="home-title">{t("homeTitle")}</h1>
          <p className="home-deck">{t("homeDeck")}</p>

          <div className="home-actions" aria-label={t("homeEntryAria")}>
            <button
              className="home-action home-action--primary"
              data-testid="home-codex-login"
              disabled={isAuthLoading || isCodexStarting}
              type="button"
              onClick={onStartCodexLogin}
            >
              {isCodexStarting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <KeyRound className="size-4" aria-hidden="true" />}
              {t("homeStartCodex")}
            </button>
            <button className="home-action home-action--secondary" data-testid="home-api-setup" type="button" onClick={onOpenProviderConfig}>
              <Terminal className="size-4" aria-hidden="true" />
              {t("homeApiSetup")}
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
            <span>{isAuthLoading ? t("homeAuthChecking") : providerLabel}</span>
          </div>

          {authError ? (
            <p className="home-auth-error" role="alert">
              {authError}
            </p>
          ) : null}
        </div>
      </section>

      <section className="home-afterfold" aria-label={t("homeAfterfoldAria")}>
        <div className="home-afterfold__item">
          <span>
            <CheckCircle2 className="size-4" aria-hidden="true" />
          </span>
          <p>{t("homeSecurityNote")}</p>
        </div>
        <button className="home-gallery-link" data-testid="home-gallery-link" type="button" onClick={onOpenGallery}>
          <ImageIcon className="size-4" aria-hidden="true" />
          {t("homeGallery")}
          <ArrowRight className="size-4" aria-hidden="true" />
        </button>
      </section>
    </main>
  );
}
