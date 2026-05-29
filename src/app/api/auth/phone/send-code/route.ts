import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured } from '@/storage/database/pg-client';
import { ensureVocUsersTable, isValidMainlandPhone, normalizePhoneNumber } from '@/lib/voc-users';
import { sendPhoneVerifyCode } from '@/lib/phone-verify';

export async function POST(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL，暂不能发送验证码' }, { status: 503 });
    }

    const body = await request.json();
    const phone = normalizePhoneNumber(String(body.phone || ''));

    if (!isValidMainlandPhone(phone)) {
      return NextResponse.json({ success: false, error: '请输入正确的手机号' }, { status: 400 });
    }

    await ensureVocUsersTable();
    const result = await sendPhoneVerifyCode(phone);

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
