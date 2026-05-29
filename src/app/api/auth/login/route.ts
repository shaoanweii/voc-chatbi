import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured } from '@/storage/database/pg-client';
import { verifyPassword } from '@/lib/password';
import { ensureVocUsersTable, findVocUserAuthByAccountId, markVocUserLogin } from '@/lib/voc-users';
import { setLoginCookie } from '@/lib/auth-cookie';

export async function POST(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL，暂不能登录' }, { status: 503 });
    }

    const body = await request.json();
    const accountId = String(body.accountId || '').trim();
    const password = String(body.password || '');

    if (!accountId) {
      return NextResponse.json({ success: false, error: '账号ID 必填' }, { status: 400 });
    }
    if (!password) {
      return NextResponse.json({ success: false, error: '密码 必填' }, { status: 400 });
    }

    await ensureVocUsersTable();

    const userAuth = await findVocUserAuthByAccountId(accountId);
    if (!userAuth) {
      return NextResponse.json({ success: false, error: '账号不存在' }, { status: 404 });
    }
    if (!userAuth.passwordHash || !verifyPassword(password, userAuth.passwordHash)) {
      return NextResponse.json({ success: false, error: '账号ID或密码不正确' }, { status: 401 });
    }

    await markVocUserLogin(userAuth.profile.id);

    const response = NextResponse.json({ success: true, data: userAuth.profile });
    setLoginCookie(response, userAuth.profile.id);

    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
