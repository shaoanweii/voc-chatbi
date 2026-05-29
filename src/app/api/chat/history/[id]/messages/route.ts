import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured, query } from '@/storage/database/pg-client';

interface RouteContext {
  params: Promise<{ id: string }>;
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

    await query(
      `DELETE FROM chat_messages
       WHERE session_id = $1`,
      [id]
    );
    await query(
      `UPDATE chat_sessions
       SET updated_at = NOW()
       WHERE id = $1
         AND expires_at > NOW()`,
      [id]
    );

    return NextResponse.json({ success: true, data: { id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
