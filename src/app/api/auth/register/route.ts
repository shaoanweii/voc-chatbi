import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured } from '@/storage/database/pg-client';
import { hashPassword } from '@/lib/password';
import {
  createVocUser,
  ensureVocUsersTable,
  findVocUserAuthByAccountId,
  findVocUserByAccountName,
  updateVocUserPassword,
} from '@/lib/voc-users';

export async function POST(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL，暂不能注册' }, { status: 503 });
    }

    const body = await request.json();
    const accountId = String(body.accountId || '').trim();
    const accountName = String(body.accountName || '').trim();
    const password = String(body.password || '');

    if (!accountId) {
      return NextResponse.json({ success: false, error: '账号ID 必填' }, { status: 400 });
    }
    if (!password) {
      return NextResponse.json({ success: false, error: '密码 必填' }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ success: false, error: '密码至少需要6位' }, { status: 400 });
    }

    await ensureVocUsersTable();

    const passwordHash = hashPassword(password);
    const existing = await findVocUserAuthByAccountId(accountId);
    if (existing?.passwordHash) {
      return NextResponse.json({ success: false, error: '账号ID 已存在' }, { status: 409 });
    }
    if (existing) {
      const user = await updateVocUserPassword(existing.profile.id, passwordHash);
      return NextResponse.json({ success: true, data: user });
    }

    // 检查 account_name 是否已被使用
    const existingName = await findVocUserByAccountName(accountName || accountId);
    if (existingName) {
      return NextResponse.json({ success: false, error: '该用户名已被使用' }, { status: 409 });
    }

    const user = await createVocUser(accountId, accountName || accountId, passwordHash);
    return NextResponse.json({ success: true, data: user });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
