import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { FormEvent } from "react";
import type { AppUser, AuthUserResponse } from "@gpt-image-canvas/shared";

interface AccountSettingsDialogProps {
  currentUser: AppUser;
  onClose: () => void;
  onProfileUpdated: (user: AppUser) => void;
  onPasswordChanged: () => void;
  onRedeemed: (user: AppUser) => void;
}

type Tab = "profile" | "password" | "redeem";

export function AccountSettingsDialog({ currentUser, onClose, onProfileUpdated, onPasswordChanged, onRedeemed }: AccountSettingsDialogProps) {
  const [tab, setTab] = useState<Tab>("profile");
  const [nickname, setNickname] = useState<string>(currentUser.nickname ?? "");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !isSaving) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSaving, onClose]);

  async function submitProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSaving(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: nickname.trim() || null })
      });
      if (!response.ok) {
        throw new Error(await readDialogError(response));
      }
      const body = (await response.json()) as AuthUserResponse;
      onProfileUpdated(body.user);
      setMessage("已更新昵称。");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "更新昵称失败。");
    } finally {
      setIsSaving(false);
    }
  }

  async function submitRedeem(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!redeemCode.trim()) {
      setError("请输入兑换码。");
      return;
    }
    setIsSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/auth/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: redeemCode.trim() })
      });
      if (!response.ok) {
        throw new Error(await readDialogError(response));
      }
      const body = (await response.json()) as { user: AppUser; credits: number };
      onRedeemed(body.user);
      setRedeemCode("");
      setMessage(`兑换成功，获得 ${body.credits} 积分。`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "兑换失败。");
    } finally {
      setIsSaving(false);
    }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致。");
      return;
    }
    if (newPassword.length < 8) {
      setError("新密码至少需要 8 位。");
      return;
    }

    setIsSaving(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword })
      });
      if (!response.ok) {
        throw new Error(await readDialogError(response));
      }
      onPasswordChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "修改密码失败。");
    } finally {
      setIsSaving(false);
    }
  }

  return createPortal(
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="账号设置">
      <div className="dialog-panel">
        <header className="dialog-header">
          <h2>账号设置</h2>
          <button type="button" className="dialog-close" onClick={onClose} disabled={isSaving} aria-label="关闭">
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        <div className="dialog-tabs" role="tablist">
          <button type="button" className="dialog-tab" data-active={tab === "profile"} onClick={() => { setTab("profile"); setError(""); setMessage(""); }}>
            修改昵称
          </button>
          <button type="button" className="dialog-tab" data-active={tab === "password"} onClick={() => { setTab("password"); setError(""); setMessage(""); }}>
            修改密码
          </button>
          <button type="button" className="dialog-tab" data-active={tab === "redeem"} onClick={() => { setTab("redeem"); setError(""); setMessage(""); }}>
            兑换码
          </button>
        </div>

        {tab === "profile" ? (
          <form className="dialog-form" onSubmit={(event) => void submitProfile(event)}>
            <label>
              <span>用户名（用于登录，不可修改）</span>
              <input value={currentUser.username} readOnly disabled />
            </label>
            <label>
              <span>昵称（留空则显示用户名）</span>
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                maxLength={32}
                placeholder={currentUser.username}
              />
            </label>
            {error ? <p className="dialog-error" role="alert">{error}</p> : null}
            {message ? <p className="dialog-success">{message}</p> : null}
            <div className="dialog-actions">
              <button type="button" className="secondary-action h-10" onClick={onClose} disabled={isSaving}>
                取消
              </button>
              <button type="submit" className="primary-action h-10" disabled={isSaving}>
                {isSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                保存
              </button>
            </div>
          </form>
        ) : tab === "redeem" ? (
          <form className="dialog-form" onSubmit={(event) => void submitRedeem(event)}>
            <label>
              <span>兑换码</span>
              <input
                value={redeemCode}
                onChange={(event) => setRedeemCode(event.target.value.toUpperCase())}
                placeholder="例如 ABCD-EFGH-IJKL"
                autoFocus
              />
            </label>
            <p className="dialog-hint">每个兑换码每个账号只能使用一次。</p>
            {error ? <p className="dialog-error" role="alert">{error}</p> : null}
            {message ? <p className="dialog-success">{message}</p> : null}
            <div className="dialog-actions">
              <button type="button" className="secondary-action h-10" onClick={onClose} disabled={isSaving}>
                关闭
              </button>
              <button type="submit" className="primary-action h-10" disabled={isSaving}>
                {isSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                兑换
              </button>
            </div>
          </form>
        ) : (
          <form className="dialog-form" onSubmit={(event) => void submitPassword(event)}>
            <label>
              <span>旧密码</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={oldPassword}
                onChange={(event) => setOldPassword(event.target.value)}
              />
            </label>
            <label>
              <span>新密码（至少 8 位）</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>
            <label>
              <span>确认新密码</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </label>
            <p className="dialog-hint">改密码后将自动注销并要求重新登录。</p>
            {error ? <p className="dialog-error" role="alert">{error}</p> : null}
            <div className="dialog-actions">
              <button type="button" className="secondary-action h-10" onClick={onClose} disabled={isSaving}>
                取消
              </button>
              <button type="submit" className="primary-action h-10" disabled={isSaving}>
                {isSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                修改密码
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body
  );
}

async function readDialogError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `请求失败，状态 ${response.status}。`;
  } catch {
    return `请求失败，状态 ${response.status}。`;
  }
}
