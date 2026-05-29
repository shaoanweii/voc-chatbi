import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured } from '@/storage/database/pg-client';
import { ensureVocUsersTable, findVocUserByAccountId } from '@/lib/voc-users';

export async function GET(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL' }, { status: 503 });
    }

    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get('accountId');
    if (!accountId) {
      return NextResponse.json({ success: false, error: '缺少 accountId 参数' }, { status: 400 });
    }

    await ensureVocUsersTable();

    const user = await findVocUserByAccountId(accountId);
    if (!user) {
      return NextResponse.json({ success: false, error: '用户不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: user });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
