import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured, query } from '@/storage/database/pg-client';

interface ChatSessionListRow {
  id: string;
  title: string | null;
  selected_table_ids: unknown;
  selected_table_names: unknown;
  created_at: Date;
  updated_at: Date | null;
  expires_at: Date;
  message_count: string;
  last_message: string | null;
}

export async function GET() {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL' }, { status: 503 });
    }

    const result = await query<ChatSessionListRow>(
      `SELECT chat_sessions.id,
              chat_sessions.title,
              chat_sessions.selected_table_ids,
              chat_sessions.selected_table_names,
              chat_sessions.created_at,
              COALESCE(chat_sessions.updated_at, chat_sessions.created_at) AS updated_at,
              chat_sessions.expires_at,
              COUNT(chat_messages.id)::text AS message_count,
              (
                SELECT content
                FROM chat_messages latest_message
                WHERE latest_message.session_id = chat_sessions.id
                ORDER BY latest_message.created_at DESC
                LIMIT 1
              ) AS last_message
       FROM chat_sessions
       LEFT JOIN chat_messages ON chat_messages.session_id = chat_sessions.id
       WHERE chat_sessions.expires_at > NOW()
         AND chat_sessions.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY chat_sessions.id
       ORDER BY COALESCE(chat_sessions.updated_at, chat_sessions.created_at) DESC
       LIMIT 100`
    );

    return NextResponse.json({
      success: true,
      data: result.rows.map((row) => ({
        id: row.id,
        title: row.title || '新对话',
        selectedTableIds: normalizeStringArray(row.selected_table_ids),
        selectedTableNames: normalizeStringArray(row.selected_table_names),
        createdAt: row.created_at,
        updatedAt: row.updated_at || row.created_at,
        expiresAt: row.expires_at,
        messageCount: Number(row.message_count || 0),
        lastMessage: row.last_message || '',
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL' }, { status: 503 });
    }

    const body = await request.json();
    const title = normalizeTitle(String(body.title || '新对话'));
    const selectedTableIds = normalizeStringArray(body.selectedTableIds);
    const selectedTableNames = normalizeStringArray(body.selectedTableNames);
    const userId = request.cookies.get('voc_user_id')?.value || null;

    const result = await query<{ id: string; title: string | null; created_at: Date }>(
      `INSERT INTO chat_sessions (title, selected_table_ids, selected_table_names, user_id, expires_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, NOW() + INTERVAL '30 days')
       RETURNING id, title, created_at`,
      [title, JSON.stringify(selectedTableIds), JSON.stringify(selectedTableNames), userId]
    );

    const session = result.rows[0];
    return NextResponse.json({
      success: true,
      data: {
        id: session.id,
        title: session.title || '新对话',
        createdAt: session.created_at,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function normalizeTitle(title: string): string {
  const normalized = title.trim() || '新对话';
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}
