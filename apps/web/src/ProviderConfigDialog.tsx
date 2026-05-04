import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Database,
  EyeOff,
  GripVertical,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCcw,
  Save,
  Server,
  ShieldCheck,
  UserRound,
  X
} from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useState, type PointerEvent } from "react";
import {
  PROVIDER_SOURCE_IDS,
  type AuthStatusResponse,
  type ProviderConfigResponse,
  type ProviderSourceId,
  type ProviderSourceView,
  type SaveProviderConfigRequest
} from "@gpt-image-canvas/shared";
import { localizedApiErrorMessage, useI18n, type Locale, type Translate } from "./i18n";

interface ProviderConfigDialogProps {
  isAuthLoading: boolean;
  isCodexStarting: boolean;
  onClose: () => void;
  onLogoutCodex: () => Promise<void>;
  onRefreshAuthStatus: () => Promise<AuthStatusResponse | null>;
  onStartCodexLogin: () => Promise<void>;
}

interface LocalProviderFormState {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: string;
}

type DialogMessageTone = "success" | "error";

interface DialogMessage {
  tone: DialogMessageTone;
  text: string;
}

const emptyLocalProviderForm: LocalProviderFormState = {
  apiKey: "",
  baseUrl: "",
  model: "",
  timeoutMs: "1200000"
};

export function ProviderConfigDialog({
  isAuthLoading,
  isCodexStarting,
  onClose,
  onLogoutCodex,
  onRefreshAuthStatus,
  onStartCodexLogin
}: ProviderConfigDialogProps) {
  const { formatDateTime: formatLocaleDateTime, locale, t } = useI18n();
  const [config, setConfig] = useState<ProviderConfigResponse | null>(null);
  const [sourceOrder, setSourceOrder] = useState<ProviderSourceId[]>([...PROVIDER_SOURCE_IDS]);
  const [localForm, setLocalForm] = useState<LocalProviderFormState>(emptyLocalProviderForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<DialogMessage | null>(null);
  const [draggingSourceId, setDraggingSourceId] = useState<ProviderSourceId | null>(null);

  const sourcesById = useMemo(() => {
    return new Map((config?.sources ?? []).map((source) => [source.id, source]));
  }, [config]);

  const activeSourceId = config?.activeSource?.id;
  const localApiKeyMask = config?.localOpenAI.apiKey.value;
  const hasSavedLocalKey = Boolean(config?.localOpenAI.apiKey.hasSecret);
  const codexSource = sourcesById.get("codex");
  const codex = codexSource?.details.codex;
  const envSource = sourcesById.get("env-openai");
  const localSource = sourcesById.get("local-openai");

  const loadProviderConfig = useCallback(
    async (signal?: AbortSignal): Promise<ProviderConfigResponse | null> => {
      setIsLoading(true);
      setMessage(null);

      try {
        const response = await fetch("/api/provider-config", { signal });
        if (!response.ok) {
          throw new Error(await readProviderConfigError(response, locale, t));
        }

        const body = (await response.json()) as ProviderConfigResponse;
        if (signal?.aborted) {
          return null;
        }

        applyProviderConfig(body);
        return body;
      } catch (error) {
        if (!signal?.aborted) {
          setMessage({
            tone: "error",
            text: error instanceof Error ? error.message : t("providerConfigLoadFailed")
          });
        }
        return null;
      } finally {
        if (!signal?.aborted) {
          setIsLoading(false);
        }
      }
    },
    [locale, t]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadProviderConfig(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadProviderConfig]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  function applyProviderConfig(nextConfig: ProviderConfigResponse): void {
    setConfig(nextConfig);
    setSourceOrder(nextConfig.sourceOrder);
    setLocalForm({
      apiKey: "",
      baseUrl: nextConfig.localOpenAI.baseUrl,
      model: nextConfig.localOpenAI.model,
      timeoutMs: String(nextConfig.localOpenAI.timeoutMs)
    });
  }

  function updateLocalForm(patch: Partial<LocalProviderFormState>): void {
    setLocalForm((current) => ({
      ...current,
      ...patch
    }));
    setMessage(null);
  }

  function moveSource(sourceId: ProviderSourceId, direction: -1 | 1): void {
    setSourceOrder((current) => {
      const sourceIndex = current.indexOf(sourceId);
      const targetIndex = sourceIndex + direction;
      if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }

      const nextOrder = [...current];
      const [removed] = nextOrder.splice(sourceIndex, 1);
      nextOrder.splice(targetIndex, 0, removed);
      return nextOrder;
    });
    setMessage(null);
  }

  function moveSourceToDropTarget(sourceId: ProviderSourceId, targetId: ProviderSourceId, pointerY: number, targetRow: HTMLElement): void {
    if (sourceId === targetId) {
      return;
    }

    setSourceOrder((current) => {
      const targetIndex = current.indexOf(targetId);
      if (targetIndex < 0) {
        return current;
      }

      const rowRect = targetRow.getBoundingClientRect();
      const insertIndex = pointerY < rowRect.top + rowRect.height / 2 ? targetIndex : targetIndex + 1;
      const sourceIndex = current.indexOf(sourceId);
      if (sourceIndex < 0) {
        return current;
      }

      const adjustedIndex = sourceIndex < insertIndex ? insertIndex - 1 : insertIndex;
      if (sourceIndex === adjustedIndex) {
        return current;
      }

      const nextOrder = [...current];
      const [removed] = nextOrder.splice(sourceIndex, 1);
      nextOrder.splice(Math.max(0, Math.min(adjustedIndex, nextOrder.length)), 0, removed);
      return nextOrder;
    });
    setMessage(null);
  }

  function handlePriorityPointerDown(event: PointerEvent<HTMLButtonElement>, sourceId: ProviderSourceId): void {
    if (event.button !== 0) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingSourceId(sourceId);
  }

  function handlePriorityPointerMove(event: PointerEvent<HTMLButtonElement>, sourceId: ProviderSourceId): void {
    if (draggingSourceId !== sourceId) {
      return;
    }

    const target = document.elementFromPoint(event.clientX, event.clientY);
    const row = target?.closest<HTMLElement>("[data-provider-source-id]");
    if (!row) {
      return;
    }

    const targetId = row?.dataset.providerSourceId as ProviderSourceId | undefined;
    if (!targetId || !PROVIDER_SOURCE_IDS.includes(targetId)) {
      return;
    }

    moveSourceToDropTarget(sourceId, targetId, event.clientY, row);
  }

  function handlePriorityPointerEnd(event: PointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingSourceId(null);
  }

  async function saveProviderConfig(): Promise<void> {
    if (!config) {
      return;
    }

    const timeoutMs = Number.parseInt(localForm.timeoutMs, 10);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      setMessage({
        tone: "error",
        text: t("providerLocalTimeoutInvalid")
      });
      return;
    }

    setIsSaving(true);
    setMessage(null);

    const apiKey = localForm.apiKey.trim();
    const body: SaveProviderConfigRequest = {
      sourceOrder,
      localOpenAI: {
        apiKey,
        preserveApiKey: !apiKey && hasSavedLocalKey,
        baseUrl: localForm.baseUrl.trim(),
        model: localForm.model.trim(),
        timeoutMs
      }
    };

    try {
      const response = await fetch("/api/provider-config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw new Error(await readProviderConfigError(response, locale, t));
      }

      const savedConfig = (await response.json()) as ProviderConfigResponse;
      applyProviderConfig(savedConfig);
      await onRefreshAuthStatus();
      setMessage({
        tone: "success",
        text: savedConfig.activeSource
          ? t("providerConfigSavedWithSource", { source: sourceLabel(savedConfig.activeSource.id, t) })
          : t("providerConfigSavedNoSource")
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : t("providerConfigSaveFailed")
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleLogoutCodex(): Promise<void> {
    await onLogoutCodex();
    await loadProviderConfig();
  }

  function handleStartCodexLogin(): void {
    void onStartCodexLogin();
  }

  const dialog = (
    <div className="provider-config-backdrop" data-testid="provider-config-dialog" role="presentation" onClick={onClose}>
      <div
        aria-labelledby="provider-config-title"
        aria-modal="true"
        className="provider-config-dialog"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="provider-config-dialog__header">
          <div className="min-w-0">
            <p>Provider Console</p>
            <h2 id="provider-config-title">{t("providerConfigTitle")}</h2>
          </div>
          <button aria-label={t("providerCloseConfig")} className="provider-config-dialog__close" type="button" onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="provider-config-dialog__body">
          {isLoading ? (
            <div className="provider-config-loading" data-testid="provider-config-loading" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("providerConfigLoading")}
            </div>
          ) : null}

          {message ? (
            <div className={`provider-config-message provider-config-message--${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
              {message.tone === "success" ? <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" /> : <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />}
              <p>{message.text}</p>
            </div>
          ) : null}

          <section className="provider-config-priority" aria-labelledby="provider-priority-title">
            <div className="provider-section-heading">
              <div>
                <p>{t("providerFallbackOrder")}</p>
                <h3 id="provider-priority-title">{t("providerPriorityTitle")}</h3>
              </div>
              <span>{activeSourceId ? t("providerCurrent", { source: sourceLabel(activeSourceId, t) }) : t("providerCurrentNone")}</span>
            </div>

            <ol className="provider-priority-list" data-testid="provider-priority-list">
              {sourceOrder.map((sourceId, index) => {
                const source = sourcesById.get(sourceId);
                return (
                  <li
                    className="provider-priority-item"
                    data-active={activeSourceId === sourceId}
                    data-dragging={draggingSourceId === sourceId}
                    data-provider-source-id={sourceId}
                    data-testid={`provider-priority-${sourceId}`}
                    key={sourceId}
                  >
                    <button
                      aria-label={t("providerDragSource", { source: sourceLabel(sourceId, t) })}
                      className="provider-priority-item__drag"
                      type="button"
                      onPointerCancel={handlePriorityPointerEnd}
                      onPointerDown={(event) => handlePriorityPointerDown(event, sourceId)}
                      onPointerMove={(event) => handlePriorityPointerMove(event, sourceId)}
                      onPointerUp={handlePriorityPointerEnd}
                    >
                      <GripVertical className="size-4" aria-hidden="true" />
                    </button>
                    <span className="provider-priority-item__rank">{index + 1}</span>
                    <span className="provider-priority-item__icon">
                      <SourceIcon sourceId={sourceId} />
                    </span>
                      <span className="provider-priority-item__copy">
                      <strong>{sourceLabel(sourceId, t)}</strong>
                      <span>{sourceStatusCopy(source, t)}</span>
                    </span>
                    <span className="provider-priority-item__badge" data-available={source?.available ?? false}>
                      {source?.available ? t("providerAvailable") : t("providerUnavailable")}
                    </span>
                    <span className="provider-priority-item__buttons">
                      <button
                        aria-label={t("providerMoveUp", { source: sourceLabel(sourceId, t) })}
                        className="provider-icon-button"
                        disabled={index === 0}
                        type="button"
                        onClick={() => moveSource(sourceId, -1)}
                      >
                        <ArrowUp className="size-3.5" aria-hidden="true" />
                      </button>
                      <button
                        aria-label={t("providerMoveDown", { source: sourceLabel(sourceId, t) })}
                        className="provider-icon-button"
                        disabled={index === sourceOrder.length - 1}
                        type="button"
                        onClick={() => moveSource(sourceId, 1)}
                      >
                        <ArrowDown className="size-3.5" aria-hidden="true" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="provider-priority-note">
              {t("providerPriorityNote")}
            </p>
          </section>

          <div className="provider-detail-grid">
            <section className="provider-detail-card" data-testid="provider-env-section" aria-labelledby="provider-env-title">
              <ProviderDetailHeader source={envSource} sourceId="env-openai" titleId="provider-env-title" />
              <dl className="provider-readonly-grid">
                <ReadonlyRow label="API Key" value={envSource?.secret.value ?? (envSource?.secret.hasSecret ? t("commonSaved") : t("commonNotSet"))} masked />
                <ReadonlyRow label={t("providerFieldBaseUrl")} value={envSource?.details.baseUrl || t("providerApiOfficial")} />
                <ReadonlyRow label={t("providerFieldModel")} value={envSource?.details.model || "gpt-image-2"} />
                <ReadonlyRow label={t("providerFieldTimeout")} value={formatTimeout(envSource?.details.timeoutMs, t)} />
              </dl>
              <p className="provider-card-hint">{t("providerCardEnvHint")}</p>
            </section>

            <section className="provider-detail-card" data-testid="provider-local-section" aria-labelledby="provider-local-title">
              <ProviderDetailHeader source={localSource} sourceId="local-openai" titleId="provider-local-title" />
              <ProfileListPanel
                config={config}
                onConfigUpdated={applyProviderConfig}
                onError={(text) => setMessage({ tone: "error", text })}
                onSuccess={(text) => setMessage({ tone: "success", text })}
              />
              <div className="provider-form-grid">
                <label className="provider-field provider-field--span">
                  <span>API Key</span>
                  <input
                    autoComplete="off"
                    className="provider-field__control"
                    data-testid="provider-local-api-key"
                    name="localOpenAIKey"
                    placeholder={localApiKeyMask ? t("providerLocalApiKeySaved", { mask: localApiKeyMask }) : t("providerLocalApiKeyPlaceholder")}
                    type="password"
                    value={localForm.apiKey}
                    onChange={(event) => updateLocalForm({ apiKey: event.target.value })}
                  />
                </label>
                {localApiKeyMask ? (
                  <p className="provider-secret-pill" data-testid="provider-local-api-key-mask">
                    <EyeOff className="size-3.5" aria-hidden="true" />
                    {t("providerSavedSecret", { mask: localApiKeyMask })}
                  </p>
                ) : null}
                <label className="provider-field provider-field--span">
                  <span>Base URL</span>
                  <input
                    className="provider-field__control"
                    data-testid="provider-local-base-url"
                    name="localOpenAIBaseUrl"
                    placeholder={t("providerBaseUrlPlaceholder")}
                    value={localForm.baseUrl}
                    onChange={(event) => updateLocalForm({ baseUrl: event.target.value })}
                  />
                </label>
                <label className="provider-field">
                  <span>{t("providerTimeoutMs")}</span>
                  <input
                    className="provider-field__control"
                    data-testid="provider-local-timeout"
                    min={1}
                    name="localOpenAITimeout"
                    type="number"
                    value={localForm.timeoutMs}
                    onChange={(event) => updateLocalForm({ timeoutMs: event.target.value })}
                  />
                </label>
                <details className="provider-advanced-field provider-field--span">
                  <summary>{t("providerAdvancedModel")}</summary>
                  <label className="provider-field">
                    <span>{t("providerFieldModel")}</span>
                    <input
                      className="provider-field__control"
                      data-testid="provider-local-model"
                      name="localOpenAIModel"
                      value={localForm.model}
                      onChange={(event) => updateLocalForm({ model: event.target.value })}
                    />
                  </label>
                </details>
              </div>
              <p className="provider-card-hint">{t("providerCardLocalHint")}</p>
            </section>

            <section className="provider-detail-card" data-testid="provider-codex-section" aria-labelledby="provider-codex-title">
              <ProviderDetailHeader source={codexSource} sourceId="codex" titleId="provider-codex-title" />
              <dl className="provider-readonly-grid">
                <ReadonlyRow label={t("providerFieldAccount")} value={codex?.email ?? codex?.accountId ?? t("providerLoggedOut")} />
                <ReadonlyRow label={t("providerFieldAvailability")} value={codex?.available ? t("providerStatusCodexCopy") : t("providerSourceMissingCodex")} />
                <ReadonlyRow label={t("providerFieldExpiresAt")} value={formatOptionalDateTime(codex?.expiresAt, formatLocaleDateTime, t)} />
                <ReadonlyRow label={t("providerFieldRefreshedAt")} value={formatOptionalDateTime(codex?.refreshedAt, formatLocaleDateTime, t)} />
                <ReadonlyRow label={t("providerFieldReason")} value={codex?.unavailableReason || (codex?.available ? t("providerNoReason") : t("providerSourceMissingCodex"))} />
              </dl>
              <div className="provider-codex-actions">
                {codex?.available ? (
                  <button className="secondary-action h-10" disabled={isAuthLoading} data-testid="provider-codex-logout" type="button" onClick={() => void handleLogoutCodex()}>
                    {isAuthLoading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <LogOut className="size-4" aria-hidden="true" />}
                    {t("providerLogoutCodex")}
                  </button>
                ) : (
                  <button
                    className="secondary-action h-10"
                    disabled={isAuthLoading || isCodexStarting}
                    data-testid="provider-codex-login"
                    type="button"
                    onClick={handleStartCodexLogin}
                  >
                    {isCodexStarting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <KeyRound className="size-4" aria-hidden="true" />}
                    {t("providerLoginCodex")}
                  </button>
                )}
              </div>
            </section>
          </div>
        </div>

        <footer className="provider-config-dialog__footer">
          <button className="secondary-action h-10" disabled={isLoading || isSaving} type="button" onClick={() => void loadProviderConfig()}>
            <RefreshCcw className="size-4" aria-hidden="true" />
            {t("providerRefresh")}
          </button>
          <button className="primary-action h-10" data-testid="provider-config-save" disabled={isLoading || isSaving || !config} type="button" onClick={() => void saveProviderConfig()}>
            {isSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
            {t("providerSave")}
          </button>
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}

function ProviderDetailHeader({
  source,
  sourceId,
  titleId
}: {
  source: ProviderSourceView | undefined;
  sourceId: ProviderSourceId;
  titleId: string;
}) {
  const { t } = useI18n();

  return (
    <header className="provider-detail-card__header">
      <span className="provider-detail-card__icon">
        <SourceIcon sourceId={sourceId} />
      </span>
      <div className="min-w-0">
        <p>{t("sourceDescription", { sourceId })}</p>
        <h3 id={titleId}>{sourceLabel(sourceId, t)}</h3>
      </div>
      <span className="provider-source-status" data-available={source?.available ?? false}>
        {source?.available ? <ShieldCheck className="size-3.5" aria-hidden="true" /> : <AlertTriangle className="size-3.5" aria-hidden="true" />}
        {source?.available ? t("providerAvailable") : t("providerUnavailable")}
      </span>
    </header>
  );
}

function ReadonlyRow({ label, masked = false, value }: { label: string; masked?: boolean; value: string }) {
  return (
    <div className="provider-readonly-row">
      <dt>{label}</dt>
      <dd data-masked={masked}>{masked ? <EyeOff className="size-3.5" aria-hidden="true" /> : null}{value}</dd>
    </div>
  );
}

function SourceIcon({ sourceId }: { sourceId: ProviderSourceId }) {
  if (sourceId === "env-openai") {
    return <Server className="size-4" aria-hidden="true" />;
  }

  if (sourceId === "local-openai") {
    return <Database className="size-4" aria-hidden="true" />;
  }

  return <UserRound className="size-4" aria-hidden="true" />;
}

function sourceLabel(sourceId: ProviderSourceId, t: Translate): string {
  return t("sourceLabel", { sourceId });
}

function sourceStatusCopy(source: ProviderSourceView | undefined, t: Translate): string {
  if (!source) {
    return t("providerSourcePending");
  }

  if (source.available) {
    return t("providerSourceConfigured");
  }

  if (source.id === "codex") {
    return source.details.codex?.unavailableReason || t("providerSourceMissingCodex");
  }

  if (source.id === "local-openai") {
    return t("providerSourceMissingKey");
  }

  return t("providerSourceMissingOpenAIKey");
}

function formatTimeout(value: number | undefined, t: Translate): string {
  if (!value) {
    return t("commonNotSet");
  }

  return `${value} ms`;
}

function formatOptionalDateTime(value: string | undefined, formatDateTime: (value: string) => string, t: Translate): string {
  if (!value) {
    return t("commonNotRecorded");
  }

  return formatDateTime(value);
}

async function readProviderConfigError(response: Response, locale: Locale, t: Translate): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return localizedApiErrorMessage({
      code: body.error?.code,
      fallbackMessage: body.error?.message,
      fallbackText: t("providerConfigRequestFailed", { status: response.status }),
      locale,
      status: response.status
    });
  } catch {
    return t("providerConfigRequestFailed", { status: response.status });
  }
}

interface ProfileListPanelProps {
  config: ProviderConfigResponse | null;
  onConfigUpdated: (config: ProviderConfigResponse) => void;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}

function ProfileListPanel({ config, onConfigUpdated, onError, onSuccess }: ProfileListPanelProps) {
  const profiles = config?.localProfiles ?? [];
  const activeProfileId = config?.activeProfileId ?? null;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  async function activateProfile(profileId: string): Promise<void> {
    setBusyId(profileId);
    try {
      const response = await fetch(`/api/provider-config/profiles/${encodeURIComponent(profileId)}/activate`, { method: "POST" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const body = (await response.json()) as ProviderConfigResponse;
      onConfigUpdated(body);
      onSuccess("已切换激活配置。");
    } catch (error) {
      onError(error instanceof Error ? error.message : "切换失败。");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteProfile(profileId: string, name: string): Promise<void> {
    if (!window.confirm(`删除配置 "${name}"？`)) {
      return;
    }
    setBusyId(profileId);
    try {
      const response = await fetch(`/api/provider-config/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const body = (await response.json()) as ProviderConfigResponse;
      onConfigUpdated(body);
      onSuccess("已删除配置。");
    } catch (error) {
      onError(error instanceof Error ? error.message : "删除失败。");
    } finally {
      setBusyId(null);
    }
  }

  async function testProfile(profileId: string): Promise<void> {
    setBusyId(profileId);
    try {
      const response = await fetch(`/api/provider-config/profiles/${encodeURIComponent(profileId)}/test`, { method: "POST" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const body = (await response.json()) as { ok: boolean; message: string };
      if (body.ok) {
        onSuccess(body.message);
      } else {
        onError(body.message);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "测试失败。");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="profile-list-panel">
      <div className="profile-list-header">
        <span>本地中转配置（点击切换激活）</span>
        <button type="button" className="secondary-action h-8" onClick={() => setCreateOpen(true)}>
          新增配置
        </button>
      </div>
      {profiles.length === 0 ? (
        <p className="profile-list-empty">尚未创建任何本地配置。点击"新增配置"添加第一个。</p>
      ) : (
        <ul className="profile-list">
          {profiles.map((profile) => {
            const isActive = profile.id === activeProfileId;
            const isBusy = busyId === profile.id;
            return (
              <li key={profile.id} className="profile-list-item" data-active={isActive}>
                <button
                  type="button"
                  className="profile-list-item__main"
                  onClick={() => void activateProfile(profile.id)}
                  disabled={isBusy || isActive}
                  title={isActive ? "当前激活" : "点击激活"}
                >
                  <strong>{profile.name}</strong>
                  <span>{profile.baseUrl || "默认 OpenAI 端点"}</span>
                  <span className="profile-list-item__model">{profile.model}</span>
                  {isActive ? <span className="profile-active-badge">已激活</span> : null}
                </button>
                <div className="profile-list-actions">
                  <button type="button" className="text-action" onClick={() => void testProfile(profile.id)} disabled={isBusy}>
                    测试连接
                  </button>
                  <button type="button" className="text-action text-action--danger" onClick={() => void deleteProfile(profile.id, profile.name)} disabled={isBusy}>
                    删除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {createOpen ? (
        <CreateProfileDialog
          onCancel={() => setCreateOpen(false)}
          onCreated={(updatedConfig) => {
            onConfigUpdated(updatedConfig);
            onSuccess("已创建配置。");
            setCreateOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

interface CreateProfileDialogProps {
  onCancel: () => void;
  onCreated: (config: ProviderConfigResponse) => void;
}

function CreateProfileDialog({ onCancel, onCreated }: CreateProfileDialogProps) {
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  async function submit(): Promise<void> {
    if (!name.trim() || !apiKey.trim()) {
      setError("请填写配置名称和 API Key。");
      return;
    }
    setIsSaving(true);
    setError("");
    try {
      const response = await fetch("/api/provider-config/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || undefined,
          model: model.trim() || undefined
        })
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const refreshed = await fetch("/api/provider-config");
      if (!refreshed.ok) {
        throw new Error(await readError(refreshed));
      }
      const body = (await refreshed.json()) as ProviderConfigResponse;
      onCreated(body);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "创建失败。");
    } finally {
      setIsSaving(false);
    }
  }

  return createPortal(
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <div className="dialog-panel">
        <header className="dialog-header">
          <h2>新增本地中转配置</h2>
          <button type="button" className="dialog-close" onClick={onCancel} disabled={isSaving} aria-label="关闭">
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        <div className="dialog-form">
          <label>
            <span>配置名称（如"OpenRouter""国内中转 A"）</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={32} autoFocus />
          </label>
          <label>
            <span>API Key</span>
            <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </label>
          <label>
            <span>Base URL（留空使用官方 OpenAI）</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
          </label>
          <label>
            <span>模型（留空使用 gpt-image-2）</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-image-2" />
          </label>
          {error ? <p className="dialog-error" role="alert">{error}</p> : null}
          <div className="dialog-actions">
            <button type="button" className="secondary-action h-10" onClick={onCancel} disabled={isSaving}>
              取消
            </button>
            <button type="button" className="primary-action h-10" onClick={() => void submit()} disabled={isSaving}>
              {isSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              创建
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `请求失败，状态 ${response.status}。`;
  } catch {
    return `请求失败，状态 ${response.status}。`;
  }
}
