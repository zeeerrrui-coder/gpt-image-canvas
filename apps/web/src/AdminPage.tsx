import { CheckCircle2, Loader2, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import type { AdminCreditAdjustmentResponse, AdminUsersResponse, AppUser } from "@gpt-image-canvas/shared";

export function AdminPage() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

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

  async function adjustCredits(user: AppUser): Promise<void> {
    const amount = Number.parseInt(amounts[user.id] ?? "", 10);
    if (!Number.isInteger(amount) || amount === 0) {
      setError("请输入非零整数积分。");
      return;
    }

    setSavingUserId(user.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/credits`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount,
          note: "后台调整"
        })
      });
      if (!response.ok) {
        throw new Error(await readAdminError(response));
      }

      const body = (await response.json()) as AdminCreditAdjustmentResponse;
      setUsers((current) => current.map((item) => (item.id === body.user.id ? body.user : item)));
      setAmounts((current) => ({ ...current, [user.id]: "" }));
      setMessage("积分已更新。");
    } catch (adjustError) {
      setError(adjustError instanceof Error ? adjustError.message : "积分调整失败。");
    } finally {
      setSavingUserId(null);
    }
  }

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
          <p>这里只管理账号和积分，不展示用户生成的图片、提示词或画布内容。</p>
        </header>

        {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
        {message ? (
          <div className="admin-alert admin-alert--success">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            {message}
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
                  <th>用户</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>积分</th>
                  <th>调整积分</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <span className="admin-user-cell">
                        <UserRound className="size-4" aria-hidden="true" />
                        {user.username}
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
                        <button className="secondary-action h-9" disabled={savingUserId === user.id} type="button" onClick={() => void adjustCredits(user)}>
                          {savingUserId === user.id ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                          保存
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

async function readAdminError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `请求失败，状态 ${response.status}。`;
  } catch {
    return `请求失败，状态 ${response.status}。`;
  }
}
