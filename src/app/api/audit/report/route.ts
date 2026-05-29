import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured, query } from '@/storage/database/pg-client';
import { getCachedSnapshot } from '@/lib/audit-scheduler';

const TOKEN_EXPR = `COALESCE((cm.metadata->'tokenUsage'->>'totalTokens')::int, LENGTH(cm.content) + LENGTH(COALESCE(cm.thinking, '')))`;

interface ReportRow {
  total_users: string;
  total_sessions: string;
  total_requests: string;
  total_success: string;
  total_failure: string;
  total_token: string;
  total_prompt_tokens: string;
  total_completion_tokens: string;
}

interface IntentRow {
  intent: string;
  session_count: string;
  request_count: string;
  token_sum: string;
}

interface TrendRow {
  day: string;
  token_sum: string;
  request_count: string;
}

interface DailyStatusRow {
  day: string;
  success_count: string;
  failure_count: string;
}

interface UserRankRow {
  account_name: string;
  account_id: string;
  avatar_url: string | null;
  request_count: string;
  total_token: string;
}

interface ErrorDetailRow {
  content: string;
  error_message: string;
  intent: string;
  account_name: string;
  created_at: string;
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

export async function GET(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL' }, { status: 503 });
    }

    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '7d';
    const force = searchParams.get('force') === '1';

    // 优先读取定时缓存，force=1 时跳过缓存直接查库
    if (!force) {
      const cached = getCachedSnapshot(range);
      if (cached) {
        return NextResponse.json({ success: true, data: { ...cached, range }, cached: true });
      }
    }

    const timeCondition = getTimeCondition(range);

    // 全局概览 — 包含 voc_users 总人数 + 输入/输出 Token
    const overviewResult = await query<ReportRow>(
      `SELECT
         (SELECT COUNT(*)::text FROM voc_users) AS total_users,
         COUNT(DISTINCT cm.session_id)::text AS total_sessions,
         COUNT(*)::text AS total_requests,
         COUNT(*) FILTER (WHERE cm.status = 'success')::text AS total_success,
         COUNT(*) FILTER (WHERE cm.status = 'failure')::text AS total_failure,
         COALESCE(SUM(${TOKEN_EXPR}), 0)::text AS total_token,
         COALESCE(SUM(COALESCE((cm.metadata->'tokenUsage'->>'promptTokens')::int, 0)), 0)::text AS total_prompt_tokens,
         COALESCE(SUM(COALESCE((cm.metadata->'tokenUsage'->>'completionTokens')::int, 0)), 0)::text AS total_completion_tokens
       FROM chat_messages cm
       WHERE cm.role = 'assistant'
         ${timeCondition}`
    );

    // 意图维度统计 — 使用人数按 cs.user_id 去重
    const intentResult = await query<IntentRow>(
      `SELECT
         COALESCE(cm.metadata->>'intent', 'unknown') AS intent,
         COUNT(DISTINCT cs.user_id)::text AS session_count,
         COUNT(*)::text AS request_count,
         COALESCE(SUM(${TOKEN_EXPR}), 0)::text AS token_sum
       FROM chat_messages cm
       JOIN chat_sessions cs ON cs.id = cm.session_id
       WHERE cm.role = 'assistant'
         ${timeCondition}
       GROUP BY cm.metadata->>'intent'
       ORDER BY COUNT(*) DESC`
    );

    // Token 消耗趋势（按天）
    const trendResult = await query<TrendRow>(
      `SELECT
         TO_CHAR(cm.created_at, 'MM-DD') AS day,
         COALESCE(SUM(${TOKEN_EXPR}), 0)::text AS token_sum,
         COUNT(*)::text AS request_count
       FROM chat_messages cm
       WHERE cm.role = 'assistant'
         ${timeCondition}
       GROUP BY TO_CHAR(cm.created_at, 'MM-DD'), cm.created_at::date
       ORDER BY cm.created_at::date`
    );

    // 每天成功/失败次数趋势
    const dailyStatusResult = await query<DailyStatusRow>(
      `SELECT
         TO_CHAR(cm.created_at, 'MM-DD') AS day,
         COUNT(*) FILTER (WHERE cm.status = 'success')::text AS success_count,
         COUNT(*) FILTER (WHERE cm.status = 'failure')::text AS failure_count
       FROM chat_messages cm
       WHERE cm.role = 'assistant'
         ${timeCondition}
       GROUP BY TO_CHAR(cm.created_at, 'MM-DD'), cm.created_at::date
       ORDER BY cm.created_at::date`
    );

    // 人员使用排行榜 Top5 — 按 voc_users 账号聚合
    const userRankResult = await query<UserRankRow>(
      `SELECT
         vu.account_name,
         vu.account_id,
         vu.avatar_url,
         COUNT(*)::text AS request_count,
         COALESCE(SUM(${TOKEN_EXPR}), 0)::text AS total_token
       FROM chat_messages cm
       JOIN chat_sessions cs ON cs.id = cm.session_id
       JOIN voc_users vu ON vu.id = cs.user_id
       WHERE cm.role = 'assistant'
         AND cs.user_id IS NOT NULL
         ${timeCondition}
       GROUP BY vu.id, vu.account_name, vu.account_id, vu.avatar_url
       ORDER BY COUNT(*) DESC
       LIMIT 5`
    );

    // 异常明细列表
    const errorDetailResult = await query<ErrorDetailRow>(
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
    );

    const overview = overviewResult.rows[0] || {
      total_users: '0',
      total_sessions: '0',
      total_requests: '0',
      total_success: '0',
      total_failure: '0',
      total_token: '0',
    };

    const totalToken = Number(overview.total_token || 0);
    const totalRequests = Number(overview.total_requests || 0);
    const totalSuccess = Number(overview.total_success || 0);
    const totalFailure = Number(overview.total_failure || 0);
    const crashRate = totalRequests > 0 ? ((totalFailure / totalRequests) * 100).toFixed(2) : '0.00';

    return NextResponse.json({
      success: true,
      data: {
        overview: {
          totalUsers: Number(overview.total_users || 0),
          totalSessions: Number(overview.total_sessions || 0),
          totalRequests,
          totalSuccess,
          totalFailure,
          totalToken,
          totalPromptTokens: Number(overview.total_prompt_tokens || 0),
          totalCompletionTokens: Number(overview.total_completion_tokens || 0),
          crashRate: Number(crashRate),
        },
        intents: intentResult.rows.map((r) => ({
          intent: r.intent,
          sessionCount: Number(r.session_count || 0),
          requestCount: Number(r.request_count || 0),
          tokenSum: Number(r.token_sum || 0),
        })),
        trends: trendResult.rows.map((r) => ({
          day: r.day,
          tokenSum: Number(r.token_sum || 0),
          requestCount: Number(r.request_count || 0),
        })),
        dailyStatus: dailyStatusResult.rows.map((r) => ({
          day: r.day,
          successCount: Number(r.success_count || 0),
          failureCount: Number(r.failure_count || 0),
        })),
        userRanks: userRankResult.rows.map((r) => ({
          accountName: r.account_name || '未知用户',
          accountId: r.account_id || '',
          avatarUrl: r.avatar_url || '',
          requestCount: Number(r.request_count || 0),
          totalToken: Number(r.total_token || 0),
        })),
        errorDetails: errorDetailResult.rows.map((r) => ({
          content: r.content || '',
          errorMessage: r.error_message || '',
          intent: r.intent || '',
          accountName: r.account_name || '',
          createdAt: r.created_at || '',
        })),
        range,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
