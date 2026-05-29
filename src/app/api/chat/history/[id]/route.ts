import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured, query } from '@/storage/database/pg-client';

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ChatSessionRow {
  id: string;
  title: string | null;
  selected_table_ids: unknown;
  selected_table_names: unknown;
  created_at: Date;
  updated_at: Date | null;
  expires_at: Date;
}

interface ChatMessageRow {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking: string | null;
  sql_text: string | null;
  sources: unknown;
  chart: unknown;
  metadata: unknown;
  created_at: Date;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL' }, { status: 503 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少会话 ID' }, { status: 400 });
    }

    const sessionResult = await query<ChatSessionRow>(
      `SELECT id, title, selected_table_ids, selected_table_names, created_at, updated_at, expires_at
       FROM chat_sessions
       WHERE id = $1
         AND expires_at > NOW()
       LIMIT 1`,
      [id]
    );
    const session = sessionResult.rows[0];
    if (!session) {
      return NextResponse.json({ success: false, error: '历史会话不存在或已过期' }, { status: 404 });
    }

    const messagesResult = await query<ChatMessageRow>(
      `SELECT id, role, content, thinking, sql_text, sources, chart, metadata, created_at
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [id]
    );

    return NextResponse.json({
      success: true,
      data: {
        session: {
          id: session.id,
          title: session.title || '新对话',
          selectedTableIds: normalizeStringArray(session.selected_table_ids),
          selectedTableNames: normalizeStringArray(session.selected_table_names),
          createdAt: session.created_at,
          updatedAt: session.updated_at || session.created_at,
          expiresAt: session.expires_at,
        },
        messages: messagesResult.rows
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            thinking: message.thinking || undefined,
            sql: message.sql_text || undefined,
            pythonCode: normalizeOptionalString(readMetadataValue(message.metadata, 'pythonCode')),
            sources: normalizeStringArray(message.sources),
            followUps: normalizeStringArray(readMetadataValue(message.metadata, 'followUps')),
            report: readMetadataValue(message.metadata, 'report'),
            chart: message.chart || readMetadataValue(message.metadata, 'chart') || undefined,
            metadata: message.metadata || {},
            timestamp: new Date(message.created_at).getTime(),
          })),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL' }, { status: 503 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少会话 ID' }, { status: 400 });
    }

    const body = await request.json();
    const title = String(body.title || '').trim();
    if (!title) {
      return NextResponse.json({ success: false, error: '标题不能为空' }, { status: 400 });
    }

    const normalizedTitle = title.length > 80 ? `${title.slice(0, 80)}...` : title;
    const result = await query<Pick<ChatSessionRow, 'id' | 'title' | 'updated_at'>>(
      `UPDATE chat_sessions
       SET title = $2,
           updated_at = NOW()
       WHERE id = $1
         AND expires_at > NOW()
       RETURNING id, title, updated_at`,
      [id, normalizedTitle]
    );

    const session = result.rows[0];
    if (!session) {
      return NextResponse.json({ success: false, error: '历史会话不存在或已过期' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: {
        id: session.id,
        title: session.title || '新对话',
        updatedAt: session.updated_at,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL' }, { status: 503 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少会话 ID' }, { status: 400 });
    }

    const result = await query<{ id: string }>(
      `DELETE FROM chat_sessions
       WHERE id = $1
       RETURNING id`,
      [id]
    );

    if (!result.rows[0]?.id) {
      return NextResponse.json({ success: false, error: '历史会话不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: { id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function readMetadataValue(metadata: unknown, key: string): unknown {
  if (!metadata || typeof metadata !== 'object') return undefined;
  return (metadata as Record<string, unknown>)[key];
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
