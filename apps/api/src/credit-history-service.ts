import { count, desc, eq } from "drizzle-orm";
import type { CreditTransactionEntry, CreditTransactionsResponse } from "./contracts.js";
import { db } from "./database.js";
import { creditTransactions } from "./schema.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export function listCreditTransactions(
  userId: string,
  options: { page?: number; pageSize?: number } = {}
): CreditTransactionsResponse {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));

  const totalRow = db
    .select({ count: count() })
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, userId))
    .get();
  const total = totalRow?.count ?? 0;

  const items = db
    .select({
      id: creditTransactions.id,
      type: creditTransactions.type,
      amount: creditTransactions.amount,
      balanceAfter: creditTransactions.balanceAfter,
      generationId: creditTransactions.generationId,
      note: creditTransactions.note,
      createdAt: creditTransactions.createdAt
    })
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, userId))
    .orderBy(desc(creditTransactions.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  return {
    items: items.map(toEntry),
    total,
    page,
    pageSize
  };
}

function toEntry(row: {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  generationId: string | null;
  note: string | null;
  createdAt: string;
}): CreditTransactionEntry {
  return {
    id: row.id,
    type: row.type,
    amount: row.amount,
    balanceAfter: row.balanceAfter,
    generationId: row.generationId,
    note: row.note,
    createdAt: row.createdAt
  };
}
