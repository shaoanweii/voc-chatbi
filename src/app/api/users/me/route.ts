import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured } from '@/storage/database/pg-client';
import { ensureVocUsersTable, findVocUserById, updateVocUserProfile } from '@/lib/voc-users';

function getUserId(request: NextRequest) {
  return request.cookies.get('voc_user_id')?.value || '';
}

export async function GET(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL' }, { status: 503 });
    }

    const userId = getUserId(request);
    if (!userId) {
      return NextResponse.json({ success: false, error: '未登录' }, { status: 401 });
    }

    await ensureVocUsersTable();

    const user = await findVocUserById(userId);
    if (!user) {
      return NextResponse.json({ success: false, error: '用户不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: user });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL' }, { status: 503 });
    }

    const userId = getUserId(request);
    if (!userId) {
      return NextResponse.json({ success: false, error: '未登录' }, { status: 401 });
    }

    const body = await request.json();
    await ensureVocUsersTable();

    const user = await updateVocUserProfile(userId, {
      accountName: String(body.accountName || '').trim(),
      avatarUrl: body.avatarUrl ? String(body.avatarUrl) : null,
      email: String(body.email || '').trim(),
      phone: String(body.phone || '').trim(),
      company: String(body.company || '').trim(),
      companyRole: String(body.companyRole || '').trim(),
      bio: String(body.bio || '').trim(),
    });

    if (!user) {
      return NextResponse.json({ success: false, error: '用户不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: user });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
