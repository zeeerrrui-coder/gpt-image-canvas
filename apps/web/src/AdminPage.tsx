import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Copy,
  Gift,
  History,
  KeyRound,
  Loader2,
  Plus,
  Power,
  ShieldCheck,
  Trash2,
  UserRound,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { AdminCreditAdjustmentResponse, AdminUsersResponse, AppUser } from "@gpt-image-canvas/shared";
import { CreditHistoryDialog } from "./CreditHistoryDialog";

interface BatchResult {
  userId: string;
  ok: boolean;
  user?: AppUser;
  error?: string;
}

export function AdminPage() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [batchAmount, setBatchAmount] = useState("");
  const [batchNote, setBatchNote] = useState("");
  const [isBatchSaving, setIsBatchSaving] = useState(false);
  const [resetTarget, setResetTarget] = useState<AppUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AppUser | null>(null);
  const [historyTarget, setHistoryTarget] = useState<AppUser | null>(null);
  const [errorLogsOpen, setErrorLogsOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadUsers(controller.signal);
    return () => controller.abort();
  }, []);

  async function loadUsers(signal?: AbortSignal): Promise<void> {
    setIsLoading(true);
    setError("");

    try {
      const response = await fetch("/api/admin/users", { signal });
      if (!response.ok) {
        throw new Error(await readAdminError(response));
      }
      const body = (await response.json()) as AdminUsersResponse;
      setUsers(body.users);
    } catch (loadError) {
      if (!signal?.aborted) {
        setError(loadError instanceof Error ? loadError.message : "后台数据加载失败。");
      }
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
      }
    }
  }

  function applyUpdatedUser(user: AppUser): void {
    setUsers((current) => current.map((item) => (item.id === user.id ? user : item)));
  }

  function showMessage(text: string): void {
    setMessage(text);
    setError("");
  }

  function showError(text: string): void {
    setError(text);
    setMessage("");
  }

  async function adjustCredits(user: AppUser): Promise<void> {
    const amount = Number.parseInt(amounts[user.id] ?? "", 10);
    if (!Number.isInteger(amount) || amount === 0) {
      showError("请输入非零整数积分。");
      return;
    }

    setSavingUserId(user.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/credits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, note: "后台调整" })
      });
      if (!response.ok) {
        throw new Error(await readAdminError(response));
      }

      const body = (await response.json()) as AdminCreditAdjustmentResponse;
      applyUpdatedUser(body.user);
      setAmounts((current) => ({ ...current, [user.id]: "" }));
      showMessage("积分已更新。");
    } catch (adjustError) {
      showError(adjustError instanceof Error ? adjustError.message : "积分调整失败。");
    } finally {
      setSavingUserId(null);
    }
  }

  async function toggleStatus(user: AppUser): Promise<void> {
    const nextStatus = user.status === "active" ? "disabled" : "active";
    setSavingUserId(user.id);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus })
      });
      if (!response.ok) {
        throw new Error(await readAdminError(response));
      }
      const body = (await response.json()) as { user: AppUser };
      applyUpdatedUser(body.user);
      showMessage(nextStatus === "disabled" ? "账号已禁用。" : "账号已启用。");
    } catch (toggleError) {
      showError(toggleError instanceof Error ? toggleError.message : "状态切换失败。");
    } finally {
      setSavingUserId(null);
    }
  }

  async function batchGrant(): Promise<void> {
    const amount = Number.parseInt(batchAmount, 10);
    if (!Number.isInteger(amount) || amount === 0) {
      showError("批量积分必须是非零整数。");
      return;
    }
    if (selectedUserIds.size === 0) {
      showError("请先勾选至少一个用户。");
      return;
    }

    setIsBatchSaving(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/admin/users/credits/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userIds: Array.from(selectedUserIds),
          amount,
          note: batchNote.trim() || "批量调整"
        })
      });
      if (!response.ok) {
        throw new Error(await readAdminError(response));
      }
      const body = (await response.json()) as { results: BatchResult[] };
      const failed = body.results.filter((item) => !item.ok);
      for (const item of body.results) {
        if (item.user) {
          applyUpdatedUser(item.user);
        }
      }
      if (failed.length === 0) {
        showMessage(`已为 ${body.results.length} 个用户调整积分。`);
        setSelectedUserIds(new Set());
        setBatchAmount("");
        setBatchNote("");
      } else {
        showError(`部分失败：${failed.length}/${body.results.length} 个用户调整失败。`);
      }
    } catch (batchError) {
      showError(batchError instanceof Error ? batchError.message : "批量调整失败。");
    } finally {
      setIsBatchSaving(false);
    }
  }

  function toggleSelect(userId: string): void {
    setSelectedUserIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }

  function toggleSelectAll(): void {
    setSelectedUserIds((current) => {
      if (current.size === users.length) {
        return new Set();
      }
      return new Set(users.map((user) => user.id));
    });
  }

  const allSelected = useMemo(() => users.length > 0 && selectedUserIds.size === users.length, [users.length, selectedUserIds.size]);

  return (
    <main className="admin-page app-view" data-testid="admin-page">
      <section className="admin-page__inner">
        <header className="admin-header">
          <div>
            <p className="admin-kicker">
              <ShieldCheck className="size-4" aria-hidden="true" />
              管理后台
            </p>
            <h1>账号与积分</h1>
          </div>
          <p>这里管理账号和积分，不展示用户生成的图片、提示词或画布内容。</p>
        </header>

        <StatsPanel onError={showError} />

        <div className="admin-toolbar">
          <button type="button" className="secondary-action h-9" onClick={() => setErrorLogsOpen(true)}>
            <AlertCircle className="size-4" aria-hidden="true" />
            错误日志
          </button>
        </div>

        {errorLogsOpen ? <ErrorLogsDialog onClose={() => setErrorLogsOpen(false)} /> : null}

        {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
        {message ? (
          <div className="admin-alert admin-alert--success">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            {message}
          </div>
        ) : null}

        {selectedUserIds.size > 0 ? (
          <div className="admin-batch-bar">
            <span>已选 {selectedUserIds.size} 个用户</span>
            <input
              inputMode="numeric"
              placeholder="例如 10 或 -2"
              value={batchAmount}
              onChange={(event) => setBatchAmount(event.target.value)}
              disabled={isBatchSaving}
            />
            <input
              placeholder="备注（可选）"
              value={batchNote}
              onChange={(event) => setBatchNote(event.target.value)}
              disabled={isBatchSaving}
            />
            <button
              type="button"
              className="primary-action h-9"
              onClick={() => void batchGrant()}
              disabled={isBatchSaving}
            >
              {isBatchSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              批量调整
            </button>
            <button
              type="button"
              className="secondary-action h-9"
              onClick={() => setSelectedUserIds(new Set())}
              disabled={isBatchSaving}
            >
              清空选择
            </button>
          </div>
        ) : null}

        {isLoading ? (
          <div className="admin-loading" role="status">
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
            正在载入账号
          </div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} aria-label="全选" />
                  </th>
                  <th>用户</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>积分</th>
                  <th>调整积分</th>
                  <th>账号操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const displayName = user.nickname?.trim() || user.username;
                  return (
                    <tr key={user.id} data-disabled={user.status === "disabled"}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedUserIds.has(user.id)}
                          onChange={() => toggleSelect(user.id)}
                          aria-label={`选择 ${user.username}`}
                        />
                      </td>
                      <td>
                        <span className="admin-user-cell">
                          <UserRound className="size-4" aria-hidden="true" />
                          <span>
                            {displayName}
                            {user.nickname ? <em className="admin-user-username">（{user.username}）</em> : null}
                          </span>
                        </span>
                      </td>
                      <td>{user.role === "admin" ? "管理员" : "普通用户"}</td>
                      <td>{user.status === "active" ? "正常" : "已禁用"}</td>
                      <td>{user.credits}</td>
                      <td>
                        <div className="admin-credit-control">
                          <input
                            inputMode="numeric"
                            placeholder="例如 10 或 -2"
                            value={amounts[user.id] ?? ""}
                            onChange={(event) => setAmounts((current) => ({ ...current, [user.id]: event.target.value }))}
                          />
                          <button
                            className="secondary-action h-9"
                            disabled={savingUserId === user.id}
                            type="button"
                            onClick={() => void adjustCredits(user)}
                          >
                            {savingUserId === user.id ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                            保存
                          </button>
                        </div>
                      </td>
                      <td>
                        <div className="admin-row-actions">
                          <button
                            type="button"
                            className="icon-action"
                            title="积分明细"
                            onClick={() => setHistoryTarget(user)}
                          >
                            <History className="size-4" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-action"
                            title={user.status === "active" ? "禁用账号" : "启用账号"}
                            onClick={() => void toggleStatus(user)}
                            disabled={savingUserId === user.id}
                          >
                            <Power className="size-4" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-action"
                            title="重置密码"
                            onClick={() => setResetTarget(user)}
                          >
                            <KeyRound className="size-4" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-action icon-action--danger"
                            title="删除账号"
                            onClick={() => setDeleteTarget(user)}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {resetTarget ? (
          <ResetPasswordDialog
            user={resetTarget}
            onClose={() => setResetTarget(null)}
            onDone={() => {
              setResetTarget(null);
              showMessage(`已重置 ${resetTarget.username} 的密码。`);
            }}
          />
        ) : null}

        {deleteTarget ? (
          <DeleteUserDialog
            user={deleteTarget}
            onClose={() => setDeleteTarget(null)}
            onDeleted={() => {
              const removed = deleteTarget;
              setDeleteTarget(null);
              setUsers((current) => current.filter((item) => item.id !== removed.id));
              setSelectedUserIds((current) => {
                const next = new Set(current);
                next.delete(removed.id);
                return next;
              });
              showMessage(`已删除账号 ${removed.username}。`);
            }}
          />
        ) : null}

        {historyTarget ? (
          <CreditHistoryDialog
            title={`${historyTarget.nickname?.trim() || historyTarget.username} 的积分明细`}
            endpoint={`/api/admin/users/${encodeURIComponent(historyTarget.id)}/credit-transactions`}
            onClose={() => setHistoryTarget(null)}
          />
        ) : null}

        <RedeemCodesPanel onMessage={showMessage} onError={showError} />
      </section>
    </main>
  );
}

interface RedeemCode {
  id: string;
  code: string;
  credits: number;
  maxUses: number;
  usesCount: number;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
}

function RedeemCodesPanel({ onMessage, onError }: { onMessage: (text: string) => void; onError: (text: string) => void }) {
  const [codes, setCodes] = useState<RedeemCode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [credits, setCredits] = useState("10");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresAt, setExpiresAt] = useState("");
  const [note, setNote] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  async function load(signal?: AbortSignal): Promise<void> {
    setIsLoading(true);
    try {
      const response = await fetch("/api/admin/redeem-codes", { signal });
      if (!response.ok) {
        throw new Error(await readAdminError(response));
      }
      const body = (await response.json()) as { codes: RedeemCode[] };
      setCodes(body.codes);
    } catch (error) {
      if (!signal?.aborted) {
        onError(error instanceof Error ? error.message : "兑换码加载失败。");
      }
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
      }
    }
  }

  async function createCode(): Promise<void> {
    const creditsNum = Number.parseInt(credits, 10);
    const maxUsesNum = Number.parseInt(maxUses, 10);
    if (!Number.isInteger(creditsNum) || creditsNum <= 0) {
      onError("请输入正整数积分。");
      return;
    }
    if (!Number.isInteger(maxUsesNum) || maxUsesNum <= 0) {
      onError("请输入正整数使用次数。");
      return;
    }

    setIsCreating(true);
    try {
      const response = await fetch("/api/admin/redeem-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credits: creditsNum,
          maxUses: maxUsesNum,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          note: note.trim() || undefined
        })
      });
      if (!response.ok) {
        throw new Error(await readAdminError(response));
      }
      const body = (await response.json()) as { code: RedeemCode };
      setCodes((current) => [body.code, ...current]);
      onMessage(`已生成兑换码：${body.code.code}`);
      setNote("");
      setExpiresAt("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "创建失败。");
    } finally {
      setIsCreating(false);
    }
  }

  async function deleteCode(id: string): Promise<void> {
    if (!window.confirm("确认删除该兑换码？")) {
      return;
    }
    try {
      const response = await fetch(`/api/admin/redeem-codes/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readAdminError(response));
      }
      setCodes((current) => current.filter((item) => item.id !== id));
      onMessage("已删除兑换码。");
    } catch (error) {
      onError(error instanceof Error ? error.message : "删除失败。");
    }
  }

  async function copyToClipboard(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      onMessage(`已复制兑换码：${code}`);
    } catch {
      onError("复制失败，请手动复制。");
    }
  }

  return (
    <section className="redeem-panel">
      <header className="redeem-panel__header">
        <h2><Gift className="size-4" aria-hidden="true" /> 兑换码</h2>
        <p>生成兑换码发给朋友，他们在"账号设置 → 兑换码"输入即可获得积分。</p>
      </header>

      <div className="redeem-create-row">
        <label>
          <span>积分</span>
          <input inputMode="numeric" value={credits} onChange={(event) => setCredits(event.target.value)} />
        </label>
        <label>
          <span>使用次数</span>
          <input inputMode="numeric" value={maxUses} onChange={(event) => setMaxUses(event.target.value)} />
        </label>
        <label>
          <span>过期时间（可选）</span>
          <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        </label>
        <label>
          <span>备注（可选）</span>
          <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={64} />
        </label>
        <button type="button" className="primary-action h-9" onClick={() => void createCode()} disabled={isCreating}>
          {isCreating ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
          生成兑换码
        </button>
      </div>

      {isLoading ? (
        <div className="admin-loading"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> 加载中</div>
      ) : codes.length === 0 ? (
        <p className="dialog-hint">暂无兑换码。</p>
      ) : (
        <table className="admin-table redeem-table">
          <thead>
            <tr>
              <th>兑换码</th>
              <th>积分</th>
              <th>使用 / 总数</th>
              <th>过期时间</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {codes.map((item) => (
              <tr key={item.id}>
                <td><code>{item.code}</code></td>
                <td>{item.credits}</td>
                <td>{item.usesCount} / {item.maxUses}</td>
                <td>{item.expiresAt ? new Date(item.expiresAt).toLocaleString() : "—"}</td>
                <td>{item.note ?? "—"}</td>
                <td>
                  <div className="admin-row-actions">
                    <button type="button" className="icon-action" title="复制" onClick={() => void copyToClipboard(item.code)}>
                      <Copy className="size-4" aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-action icon-action--danger" title="删除" onClick={() => void deleteCode(item.id)}>
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: AppUser; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  async function submit(): Promise<void> {
    if (password.length < 8) {
      setError("新密码至少需要 8 位。");
      return;
    }
    setIsSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/password-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (!response.ok) {
        throw new Error(await readAdminError(response));
      }
      onDone();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "重置失败。");
    } finally {
      setIsSaving(false);
    }
  }

  return createPortal(
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <div className="dialog-panel">
        <header className="dialog-header">
          <h2>重置 {user.username} 的密码</h2>
          <button type="button" className="dialog-close" onClick={onClose} disabled={isSaving} aria-label="关闭">
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        <div className="dialog-form">
          <label>
            <span>新密码（至少 8 位）</span>
            <input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
          </label>
          <p className="dialog-hint">用户的当前会话会被注销。</p>
          {error ? <p className="dialog-error" role="alert">{error}</p> : null}
          <div className="dialog-actions">
            <button type="button" className="secondary-action h-10" onClick={onClose} disabled={isSaving}>
              取消
            </button>
            <button type="button" className="primary-action h-10" onClick={() => void submit()} disabled={isSaving}>
              {isSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              确认重置
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function DeleteUserDialog({ user, onClose, onDeleted }: { user: AppUser; onClose: () => void; onDeleted: () => void }) {
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  async function submit(): Promise<void> {
    if (confirmText !== user.username) {
      setError("请输入用户名以确认删除。");
      return;
    }
    setIsSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE"
      });
      if (!response.ok) {
        throw new Error(await readAdminError(response));
      }
      onDeleted();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "删除失败。");
    } finally {
      setIsSaving(false);
    }
  }

  return createPortal(
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <div className="dialog-panel">
        <header className="dialog-header">
          <h2>删除账号</h2>
          <button type="button" className="dialog-close" onClick={onClose} disabled={isSaving} aria-label="关闭">
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        <div className="dialog-form">
          <p className="dialog-hint">
            将永久删除账号 <strong>{user.username}</strong>，连带其会话、画布、生成历史、画廊都会消失（数据库级联删除）。此操作不可恢复。
          </p>
          <label>
            <span>请输入用户名 <code>{user.username}</code> 以确认</span>
            <input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} autoFocus />
          </label>
          {error ? <p className="dialog-error" role="alert">{error}</p> : null}
          <div className="dialog-actions">
            <button type="button" className="secondary-action h-10" onClick={onClose} disabled={isSaving}>
              取消
            </button>
            <button type="button" className="primary-action h-10" onClick={() => void submit()} disabled={isSaving} style={{ background: "#dc2626" }}>
              {isSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              永久删除
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

interface AdminStats {
  totalUsers: number;
  activeUsersLast7d: number;
  totalGenerations: number;
  generationsLast7d: number;
  totalSucceededOutputs: number;
  totalFailedOutputs: number;
  totalCreditsGranted: number;
  totalCreditsConsumed: number;
  totalRedeemCodes: number;
  totalErrors24h: number;
  diskUsageBytes: number;
}

function StatsPanel({ onError }: { onError: (text: string) => void }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/admin/stats", { signal: controller.signal });
        if (!response.ok) {
          throw new Error(await readAdminError(response));
        }
        const body = (await response.json()) as AdminStats;
        if (!controller.signal.aborted) {
          setStats(body);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          onError(error instanceof Error ? error.message : "仪表盘加载失败。");
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [onError]);

  if (isLoading || !stats) {
    return null;
  }

  const failureRate = stats.totalSucceededOutputs + stats.totalFailedOutputs > 0
    ? Math.round((stats.totalFailedOutputs / (stats.totalSucceededOutputs + stats.totalFailedOutputs)) * 1000) / 10
    : 0;

  return (
    <section className="stats-panel">
      <header><BarChart3 className="size-4" aria-hidden="true" /> 仪表盘</header>
      <div className="stats-grid">
        <StatCard label="总用户" value={stats.totalUsers} />
        <StatCard label="近 7 天活跃" value={stats.activeUsersLast7d} />
        <StatCard label="总生成次数" value={stats.totalGenerations} hint={`近 7 天 ${stats.generationsLast7d}`} />
        <StatCard label="成功 / 失败" value={`${stats.totalSucceededOutputs} / ${stats.totalFailedOutputs}`} hint={`失败率 ${failureRate}%`} />
        <StatCard label="积分发放 / 消耗" value={`${stats.totalCreditsGranted} / ${stats.totalCreditsConsumed}`} />
        <StatCard label="兑换码总数" value={stats.totalRedeemCodes} />
        <StatCard label="24h 错误数" value={stats.totalErrors24h} />
        <StatCard label="数据占用" value={formatBytes(stats.diskUsageBytes)} />
      </div>
    </section>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value}</div>
      {hint ? <div className="stat-card__hint">{hint}</div> : null}
    </div>
  );
}

interface ErrorLogEntry {
  id: string;
  path: string;
  method: string;
  status: number | null;
  code: string | null;
  message: string;
  userId: string | null;
  createdAt: string;
}

function ErrorLogsDialog({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<ErrorLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/admin/error-logs?pageSize=50", { signal: controller.signal });
        if (!response.ok) {
          throw new Error(await readAdminError(response));
        }
        const body = (await response.json()) as { items: ErrorLogEntry[]; total: number };
        setItems(body.items);
        setTotal(body.total);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "错误日志加载失败。");
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, []);

  return createPortal(
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <div className="dialog-panel dialog-panel--wide">
        <header className="dialog-header">
          <h2>错误日志（最近 50 条 / 共 {total}）</h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭">
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        {isLoading ? (
          <div className="dialog-loading"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> 加载中</div>
        ) : error ? (
          <p className="dialog-error" role="alert">{error}</p>
        ) : items.length === 0 ? (
          <p className="dialog-hint">暂无错误日志。</p>
        ) : (
          <div className="error-logs-table-wrap">
            <table className="error-logs-table">
              <thead>
                <tr><th>时间</th><th>方法</th><th>路径</th><th>状态</th><th>错误码</th><th>消息</th></tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.createdAt).toLocaleString()}</td>
                    <td>{entry.method}</td>
                    <td><code>{entry.path}</code></td>
                    <td>{entry.status ?? "—"}</td>
                    <td>{entry.code ?? "—"}</td>
                    <td className="error-logs-message">{entry.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function readAdminError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `请求失败，状态 ${response.status}。`;
  } catch {
    return `请求失败，状态 ${response.status}。`;
  }
}
