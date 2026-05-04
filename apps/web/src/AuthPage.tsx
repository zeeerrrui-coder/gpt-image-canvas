import { ImageIcon, Loader2, LogIn, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { AppConfig, AppUser, AuthUserResponse } from "@gpt-image-canvas/shared";

interface AuthPageProps {
  onAuthenticated: (user: AppUser) => void;
}

type AuthMode = "login" | "register";

export function AuthPage({ onAuthenticated }: AuthPageProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [allowRegistration, setAllowRegistration] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/config", { signal: controller.signal });
        if (!response.ok) {
          return;
        }
        const config = (await response.json()) as AppConfig;
        if (typeof config.allowRegistration === "boolean") {
          setAllowRegistration(config.allowRegistration);
          if (!config.allowRegistration) {
            setMode("login");
          }
        }
      } catch {
        // network error: keep default (allow registration)
      }
    })();
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const response = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          username,
          password
        })
      });
      if (!response.ok) {
        throw new Error(await readAuthError(response));
      }

      const body = (await response.json()) as AuthUserResponse;
      onAuthenticated(body.user);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "登录失败，请重试。");
    } finally {
      setIsSubmitting(false);
    }
  }

  const isLogin = mode === "login";

  return (
    <main className="auth-page app-view" data-testid="auth-page">
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-panel__brand">
          <ImageIcon className="size-6" aria-hidden="true" />
          <div>
            <h1 id="auth-title">图像画布</h1>
            <p>登录后使用画布和画廊。新账号需要管理员发放积分后才能生成图片。</p>
          </div>
        </div>

        {allowRegistration ? (
          <div className="auth-tabs" role="tablist" aria-label="账号入口">
            <button className="auth-tab" data-active={isLogin} type="button" onClick={() => setMode("login")}>
              登录
            </button>
            <button className="auth-tab" data-active={!isLogin} type="button" onClick={() => setMode("register")}>
              注册
            </button>
          </div>
        ) : (
          <p className="auth-closed-note">当前不开放注册，请联系管理员获取账号。</p>
        )}

        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>用户名</span>
            <input
              autoComplete="username"
              minLength={1}
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              autoComplete={isLogin ? "current-password" : "new-password"}
              minLength={8}
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {error ? (
            <p className="auth-error" role="alert">
              {error}
            </p>
          ) : null}

          <button className="primary-action h-11" disabled={isSubmitting} type="submit">
            {isSubmitting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : isLogin ? <LogIn className="size-4" aria-hidden="true" /> : <UserPlus className="size-4" aria-hidden="true" />}
            {isLogin ? "登录" : "注册"}
          </button>
        </form>
      </section>
    </main>
  );
}

async function readAuthError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `请求失败，状态 ${response.status}。`;
  } catch {
    return `请求失败，状态 ${response.status}。`;
  }
}
