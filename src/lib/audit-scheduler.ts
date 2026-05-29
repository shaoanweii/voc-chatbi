import { isPostgresConfigured, query } from '@/storage/database/pg-client';

interface AuditSnapshot {
  range: string;
  overview: Record<string, number>;
  intents: Array<{ intent: string; sessionCount: number; requestCount: number; tokenSum: number }>;
  trends: Array<{ day: string; tokenSum: number; requestCount: number }>;
  dailyStatus: Array<{ day: string; successCount: number; failureCount: number }>;
  userRanks: Array<{ accountName: string; accountId: string; avatarUrl: string; requestCount: number; totalToken: number }>;
  errorDetails: Array<{ content: string; errorMessage: string; intent: string; accountName: string; createdAt: string }>;
  refreshedAt: number;
}

const cache = new Map<string, AuditSnapshot>();
const REFRESH_INTERVAL_MS = 3_600_000; // 1 小时
let schedulerStarted = false;

export function getCachedSnapshot(range: string): AuditSnapshot | null {
  return cache.get(range) || null;
}

export async function forceRefreshAuditCache(): Promise<void> {
  if (!isPostgresConfigured()) return;
  const ranges = ['today', '7d', '30d'];
  for (const range of ranges) {
    try {
      const snapshot = await computeAuditSnapshot(range);
      if (snapshot) cache.set(range, snapshot);
    } catch {
      // 静默跳过单次失败
    }
  }
}

export function startAuditRefreshScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  if (!isPostgresConfigured()) return;

  forceRefreshAuditCache();

  setInterval(() => {
    forceRefreshAuditCache();
  }, REFRESH_INTERVAL_MS);
}

async function computeAuditSnapshot(range: string): Promise<AuditSnapshot | null> {
  if (!isPostgresConfigured()) return null;

  const timeCondition = getTimeCondition(range);
  const tokenExpr = `COALESCE((cm.metadata->'tokenUsage'->>'totalTokens')::int, LENGTH(cm.content) + LENGTH(COALESCE(cm.thinking, '')))`;

  try {
    const [overviewR, intentR, trendR, dailyR, userR, errorR] = await Promise.all([
      query<Record<string, string>>(
        `SELECT
           (SELECT COUNT(*)::text FROM voc_users) AS total_users,
           COUNT(DISTINCT cm.session_id)::text AS total_sessions,
           COUNT(*)::text AS total_requests,
           COUNT(*) FILTER (WHERE cm.status = 'success')::text AS total_success,
           COUNT(*) FILTER (WHERE cm.status = 'failure')::text AS total_failure,
           COALESCE(SUM(${tokenExpr}), 0)::text AS total_token,
           COALESCE(SUM(COALESCE((cm.metadata->'tokenUsage'->>'promptTokens')::int, 0)), 0)::text AS total_prompt_tokens,
           COALESCE(SUM(COALESCE((cm.metadata->'tokenUsage'->>'completionTokens')::int, 0)), 0)::text AS total_completion_tokens
         FROM chat_messages cm
         WHERE cm.role = 'assistant'
           ${timeCondition}`
      ),
      query<Record<string, string>>(
        `SELECT
           COALESCE(cm.metadata->>'intent', 'unknown') AS intent,
           COUNT(DISTINCT cs.user_id)::text AS session_count,
           COUNT(*)::text AS request_count,
           COALESCE(SUM(${tokenExpr}), 0)::text AS token_sum
         FROM chat_messages cm
         JOIN chat_sessions cs ON cs.id = cm.session_id
         WHERE cm.role = 'assistant'
           ${timeCondition}
         GROUP BY cm.metadata->>'intent'
         ORDER BY COUNT(*) DESC`
      ),
      query<Record<string, string>>(
        `SELECT
           TO_CHAR(cm.created_at, 'MM-DD') AS day,
           COALESCE(SUM(${tokenExpr}), 0)::text AS token_sum,
           COUNT(*)::text AS request_count
         FROM chat_messages cm
         WHERE cm.role = 'assistant'
           ${timeCondition}
         GROUP BY TO_CHAR(cm.created_at, 'MM-DD'), cm.created_at::date
         ORDER BY cm.created_at::date`
      ),
      query<Record<string, string>>(
        `SELECT
           TO_CHAR(cm.created_at, 'MM-DD') AS day,
           COUNT(*) FILTER (WHERE cm.status = 'success')::text AS success_count,
           COUNT(*) FILTER (WHERE cm.status = 'failure')::text AS failure_count
         FROM chat_messages cm
         WHERE cm.role = 'assistant'
           ${timeCondition}
         GROUP BY TO_CHAR(cm.created_at, 'MM-DD'), cm.created_at::date
         ORDER BY cm.created_at::date`
      ),
      query<Record<string, string>>(
        `SELECT
           vu.account_name,
           vu.account_id,
           vu.avatar_url,
           COUNT(*)::text AS request_count,
           COALESCE(SUM(${tokenExpr}), 0)::text AS total_token
         FROM chat_messages cm
         JOIN chat_sessions cs ON cs.id = cm.session_id
         JOIN voc_users vu ON vu.id = cs.user_id
         WHERE cm.role = 'assistant'
           AND cs.user_id IS NOT NULL
           ${timeCondition}
         GROUP BY vu.id, vu.account_name, vu.account_id, vu.avatar_url
         ORDER BY COUNT(*) DESC
         LIMIT 5`
      ),
      query<Record<string, string>>(
        `SELECT
           LEFT(cm.content, 200) AS content,
           COALESCE(cm.error_message, '未知错误') AS error_message,
           COALESCE(cm.metadata->>'intent', 'unknown') AS intent,
           COALESCE(vu.account_name, '匿名用户') AS account_name,
           TO_CHAR(cm.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
         FROM chat_messages cm
         LEFT JOIN chat_sessions cs ON cs.id = cm.session_id
         LEFT JOIN voc_users vu ON vu.id = cs.user_id
         WHERE cm.role = 'assistant'
           AND cm.status = 'failure'
           ${timeCondition}
         ORDER BY cm.created_at DESC
         LIMIT 20`
      ),
    ]);

    const ov = overviewR.rows[0] || {};
    const totalRequests = Number(ov.total_requests || 0);
    const totalFailure = Number(ov.total_failure || 0);

    return {
      range,
      overview: {
        totalUsers: Number(ov.total_users || 0),
        totalSessions: Number(ov.total_sessions || 0),
        totalRequests,
        totalSuccess: Number(ov.total_success || 0),
        totalFailure,
        totalToken: Number(ov.total_token || 0),
        totalPromptTokens: Number(ov.total_prompt_tokens || 0),
        totalCompletionTokens: Number(ov.total_completion_tokens || 0),
      },
      intents: intentR.rows.map((r) => ({
        intent: String(r.intent || ''),
        sessionCount: Number(r.session_count || 0),
        requestCount: Number(r.request_count || 0),
        tokenSum: Number(r.token_sum || 0),
      })),
      trends: trendR.rows.map((r) => ({
        day: String(r.day || ''),
        tokenSum: Number(r.token_sum || 0),
        requestCount: Number(r.request_count || 0),
      })),
      dailyStatus: dailyR.rows.map((r) => ({
        day: String(r.day || ''),
        successCount: Number(r.success_count || 0),
        failureCount: Number(r.failure_count || 0),
      })),
      userRanks: userR.rows.map((r) => ({
        accountName: String(r.account_name || '未知用户'),
        accountId: String(r.account_id || ''),
        avatarUrl: String(r.avatar_url || ''),
        requestCount: Number(r.request_count || 0),
        totalToken: Number(r.total_token || 0),
      })),
      errorDetails: errorR.rows.map((r) => ({
        content: String(r.content || ''),
        errorMessage: String(r.error_message || ''),
        intent: String(r.intent || ''),
        accountName: String(r.account_name || ''),
        createdAt: String(r.created_at || ''),
      })),
      refreshedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

function getTimeCondition(range: string): string {
  switch (range) {
    case 'today':
      return "AND cm.created_at >= CURRENT_DATE";
    case '7d':
      return "AND cm.created_at >= NOW() - INTERVAL '7 days'";
    case '30d':
    default:
      return "AND cm.created_at >= NOW() - INTERVAL '30 days'";
  }
}
