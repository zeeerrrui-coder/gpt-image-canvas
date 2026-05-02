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

const sourceCopy: Record<
  ProviderSourceId,
  {
    description: string;
    label: string;
  }
> = {
  "env-openai": {
    description: "只读读取 .env 或运行时环境变量",
    label: "环境 OpenAI"
  },
  "local-openai": {
    description: "保存在本机 SQLite 的 OpenAI 兼容配置",
    label: "本地 OpenAI"
  },
  codex: {
    description: "使用本机 Codex 授权会话",
    label: "Codex"
  }
};

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
          throw new Error(await readProviderConfigError(response));
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
            text: error instanceof Error ? error.message : "无法读取服务配置。"
          });
        }
        return null;
      } finally {
        if (!signal?.aborted) {
          setIsLoading(false);
        }
      }
    },
    []
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
        text: "本地 API 超时时间必须是正整数毫秒。"
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
        throw new Error(await readProviderConfigError(response));
      }

      const savedConfig = (await response.json()) as ProviderConfigResponse;
      applyProviderConfig(savedConfig);
      await onRefreshAuthStatus();
      setMessage({
        tone: "success",
        text: savedConfig.activeSource
          ? `配置已保存，当前使用${sourceLabel(savedConfig.activeSource.id)}。`
          : "配置已保存，但还没有可用的生成服务。"
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "保存服务配置失败。"
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
            <h2 id="provider-config-title">生成服务配置</h2>
          </div>
          <button aria-label="关闭生成服务配置" className="provider-config-dialog__close" type="button" onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="provider-config-dialog__body">
          {isLoading ? (
            <div className="provider-config-loading" data-testid="provider-config-loading" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              正在读取生成服务配置
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
                <p>Fallback Order</p>
                <h3 id="provider-priority-title">优先级</h3>
              </div>
              <span>{activeSourceId ? `当前：${sourceLabel(activeSourceId)}` : "当前：暂无可用"}</span>
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
                      aria-label={`拖动调整${sourceLabel(sourceId)}优先级`}
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
                      <strong>{sourceLabel(sourceId)}</strong>
                      <span>{sourceStatusCopy(source)}</span>
                    </span>
                    <span className="provider-priority-item__badge" data-available={source?.available ?? false}>
                      {source?.available ? "可用" : "不可用"}
                    </span>
                    <span className="provider-priority-item__buttons">
                      <button
                        aria-label={`上移${sourceLabel(sourceId)}`}
                        className="provider-icon-button"
                        disabled={index === 0}
                        type="button"
                        onClick={() => moveSource(sourceId, -1)}
                      >
                        <ArrowUp className="size-3.5" aria-hidden="true" />
                      </button>
                      <button
                        aria-label={`下移${sourceLabel(sourceId)}`}
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
              按顺序选择第一个已配置且可用的来源；上游请求已经发出后不会自动切换到下一个来源。
            </p>
          </section>

          <div className="provider-detail-grid">
            <section className="provider-detail-card" data-testid="provider-env-section" aria-labelledby="provider-env-title">
              <ProviderDetailHeader source={envSource} sourceId="env-openai" titleId="provider-env-title" />
              <dl className="provider-readonly-grid">
                <ReadonlyRow label="API Key" value={envSource?.secret.value ?? (envSource?.secret.hasSecret ? "已保存" : "未设置")} masked />
                <ReadonlyRow label="Base URL" value={envSource?.details.baseUrl || "官方 OpenAI API"} />
                <ReadonlyRow label="模型" value={envSource?.details.model || "gpt-image-2"} />
                <ReadonlyRow label="超时" value={formatTimeout(envSource?.details.timeoutMs)} />
              </dl>
              <p className="provider-card-hint">修改 .env 或运行时环境变量后，需要重启 API 服务才会生效。</p>
            </section>

            <section className="provider-detail-card" data-testid="provider-local-section" aria-labelledby="provider-local-title">
              <ProviderDetailHeader source={localSource} sourceId="local-openai" titleId="provider-local-title" />
              <div className="provider-form-grid">
                <label className="provider-field provider-field--span">
                  <span>API Key</span>
                  <input
                    autoComplete="off"
                    className="provider-field__control"
                    data-testid="provider-local-api-key"
                    name="localOpenAIKey"
                    placeholder={localApiKeyMask ? `已保存：${localApiKeyMask}，输入新 key 可替换` : "粘贴 OpenAI 或兼容端点 API Key"}
                    type="password"
                    value={localForm.apiKey}
                    onChange={(event) => updateLocalForm({ apiKey: event.target.value })}
                  />
                </label>
                {localApiKeyMask ? (
                  <p className="provider-secret-pill" data-testid="provider-local-api-key-mask">
                    <EyeOff className="size-3.5" aria-hidden="true" />
                    当前保存值：{localApiKeyMask}
                  </p>
                ) : null}
                <label className="provider-field provider-field--span">
                  <span>Base URL</span>
                  <input
                    className="provider-field__control"
                    data-testid="provider-local-base-url"
                    name="localOpenAIBaseUrl"
                    placeholder="留空使用官方 OpenAI API"
                    value={localForm.baseUrl}
                    onChange={(event) => updateLocalForm({ baseUrl: event.target.value })}
                  />
                </label>
                <label className="provider-field">
                  <span>超时（毫秒）</span>
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
                  <summary>高级模型字段</summary>
                  <label className="provider-field">
                    <span>模型</span>
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
              <p className="provider-card-hint">本地 API Key 只保存到本机 SQLite；读取接口只返回掩码。</p>
            </section>

            <section className="provider-detail-card" data-testid="provider-codex-section" aria-labelledby="provider-codex-title">
              <ProviderDetailHeader source={codexSource} sourceId="codex" titleId="provider-codex-title" />
              <dl className="provider-readonly-grid">
                <ReadonlyRow label="账号" value={codex?.email ?? codex?.accountId ?? "未登录"} />
                <ReadonlyRow label="可用性" value={codex?.available ? "Codex 会话可用" : "Codex 会话不可用"} />
                <ReadonlyRow label="过期时间" value={formatDateTime(codex?.expiresAt)} />
                <ReadonlyRow label="刷新时间" value={formatDateTime(codex?.refreshedAt)} />
                <ReadonlyRow label="不可用原因" value={codex?.unavailableReason || (codex?.available ? "无" : "未找到可用会话")} />
              </dl>
              <div className="provider-codex-actions">
                {codex?.available ? (
                  <button className="secondary-action h-10" disabled={isAuthLoading} data-testid="provider-codex-logout" type="button" onClick={() => void handleLogoutCodex()}>
                    {isAuthLoading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <LogOut className="size-4" aria-hidden="true" />}
                    退出 Codex
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
                    登录 Codex
                  </button>
                )}
              </div>
            </section>
          </div>
        </div>

        <footer className="provider-config-dialog__footer">
          <button className="secondary-action h-10" disabled={isLoading || isSaving} type="button" onClick={() => void loadProviderConfig()}>
            <RefreshCcw className="size-4" aria-hidden="true" />
            重新读取
          </button>
          <button className="primary-action h-10" data-testid="provider-config-save" disabled={isLoading || isSaving || !config} type="button" onClick={() => void saveProviderConfig()}>
            {isSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
            保存配置
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
  return (
    <header className="provider-detail-card__header">
      <span className="provider-detail-card__icon">
        <SourceIcon sourceId={sourceId} />
      </span>
      <div className="min-w-0">
        <p>{sourceCopy[sourceId].description}</p>
        <h3 id={titleId}>{sourceLabel(sourceId)}</h3>
      </div>
      <span className="provider-source-status" data-available={source?.available ?? false}>
        {source?.available ? <ShieldCheck className="size-3.5" aria-hidden="true" /> : <AlertTriangle className="size-3.5" aria-hidden="true" />}
        {source?.available ? "可用" : "不可用"}
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

function sourceLabel(sourceId: ProviderSourceId): string {
  return sourceCopy[sourceId].label;
}

function sourceStatusCopy(source: ProviderSourceView | undefined): string {
  if (!source) {
    return "等待读取状态";
  }

  if (source.available) {
    return "已配置，可参与生成";
  }

  if (source.id === "codex") {
    return source.details.codex?.unavailableReason || "未登录 Codex 或会话不可用";
  }

  if (source.id === "local-openai") {
    return "未保存本地 API Key";
  }

  return "未设置 OPENAI_API_KEY";
}

function formatTimeout(value: number | undefined): string {
  if (!value) {
    return "未设置";
  }

  return `${value} ms`;
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "未记录";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

async function readProviderConfigError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ? `${body.error.message}（HTTP ${response.status}）` : `服务配置请求失败，状态 ${response.status}。`;
  } catch {
    return `服务配置请求失败，状态 ${response.status}。`;
  }
}
