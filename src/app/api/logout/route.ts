import { NextResponse } from 'next/server';

export async function POST() {
  try {
    // 清除认证 cookie
    const response = NextResponse.json({ success: true });
    
    // 清除 voc_user_id cookie
    response.cookies.set('voc_user_id', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    });
    
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
