import { NextResponse } from 'next/server';

export const loginMaxAgeSeconds = 60 * 60 * 24 * 7;

function shouldUseSecureCookie() {
  if (process.env.VOC_COOKIE_SECURE === 'true') {
    return true;
  }
  if (process.env.VOC_COOKIE_SECURE === 'false') {
    return false;
  }
  return process.env.NODE_ENV === 'production';
}

export function setLoginCookie(response: NextResponse, userId: string) {
  response.cookies.set('voc_user_id', userId, {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: loginMaxAgeSeconds,
  });
}
