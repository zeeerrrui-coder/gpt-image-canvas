import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { CreditTransactionEntry, CreditTransactionsResponse } from "@gpt-image-canvas/shared";

interface CreditHistoryDialogProps {
  title?: string;
  endpoint?: string;
  onClose: () => void;
}

const PAGE_SIZE = 20;

const TYPE_LABELS: Record<string, string> = {
  admin_grant: "管理员发放",
  admin_revoke: "管理员扣减",
  registration_bonus: "注册赠送",
  generation_reserve: "生成预扣",
  generation_refund: "生成退回",
  generation_deduct: "生成扣分",
  redeem_code: "兑换码"
};

export function CreditHistoryDialog({ title = "积分明细", endpoint = "/api/auth/credit-transactions", onClose }: CreditHistoryDialogProps) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CreditTransactionsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError("");

    void (async () => {
      try {
        const url = `${endpoint}?page=${page}&pageSize=${PAGE_SIZE}`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        const body = (await response.json()) as CreditTransactionsResponse;
        if (!controller.signal.aborted) {
          setData(body);
        }
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "积分明细加载失败。");
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [endpoint, page]);

  const totalPages = useMemo(() => {
    if (!data) {
      return 1;
    }
    return Math.max(1, Math.ceil(data.total / data.pageSize));
  }, [data]);

  return createPortal(
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog-panel dialog-panel--wide">
        <header className="dialog-header">
          <h2>{title}</h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭">
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        {isLoading ? (
          <div className="dialog-loading">
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
            <span>加载中</span>
          </div>
        ) : error ? (
          <p className="dialog-error" role="alert">{error}</p>
        ) : data && data.items.length === 0 ? (
          <p className="dialog-hint">暂无积分流水。</p>
        ) : data ? (
          <>
            <div className="credit-history-table-wrap">
              <table className="credit-history-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>变动</th>
                    <th>余额</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id}>
                      <td className="credit-history-time">{formatTime(item.createdAt)}</td>
                      <td>{labelFor(item)}</td>
                      <td className={item.amount >= 0 ? "credit-history-positive" : "credit-history-negative"}>
                        {item.amount >= 0 ? `+${item.amount}` : item.amount}
                      </td>
                      <td>{item.balanceAfter}</td>
                      <td className="credit-history-note">{item.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer className="credit-history-footer">
              <span>共 {data.total} 条 · 第 {data.page} / {totalPages} 页</span>
              <div className="credit-history-pager">
                <button
                  type="button"
                  className="secondary-action h-9"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                  上一页
                </button>
                <button
                  type="button"
                  className="secondary-action h-9"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                >
                  下一页
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </div>
            </footer>
          </>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

function labelFor(entry: CreditTransactionEntry): string {
  return TYPE_LABELS[entry.type] ?? entry.type;
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `请求失败，状态 ${response.status}。`;
  } catch {
    return `请求失败，状态 ${response.status}。`;
  }
}
