import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured } from '@/storage/database/pg-client';
import {
  ensureVocUsersTable,
  findOrCreatePhoneUser,
  isValidMainlandPhone,
  normalizePhoneNumber,
} from '@/lib/voc-users';
import { checkPhoneVerifyCode } from '@/lib/phone-verify';
import { setLoginCookie } from '@/lib/auth-cookie';

export async function POST(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL，暂不能登录' }, { status: 503 });
    }

    const body = await request.json();
    const phone = normalizePhoneNumber(String(body.phone || ''));
    const code = String(body.code || '').trim();

    if (!isValidMainlandPhone(phone)) {
      return NextResponse.json({ success: false, error: '请输入正确的手机号' }, { status: 400 });
    }
    if (!code) {
      return NextResponse.json({ success: false, error: '请输入短信验证码' }, { status: 400 });
    }

    await ensureVocUsersTable();

    const verified = await checkPhoneVerifyCode(phone, code);
    if (!verified) {
      return NextResponse.json({ success: false, error: '验证码不正确或已过期' }, { status: 401 });
    }

    const user = await findOrCreatePhoneUser(phone);
    const response = NextResponse.json({ success: true, data: user });
    setLoginCookie(response, user.id);

    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
