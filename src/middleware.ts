import { NextRequest, NextResponse } from 'next/server';

const pageRoutes = ['/', '/chatbi', '/data-prep', '/voc_data_report'];
const apiRoutes = ['/api/chat', '/api/users', '/api/audit'];
const publicApiPrefixes = ['/api/auth', '/api/logout'];
const publicPaths = ['/login'];
const routeAliases = [
  { from: '/data-pere', to: '/data-prep' },
];

/**
 * 登录态中间件：保护页面路由和 API 路由，未登录则重定向或返回 401
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const aliasPathname = resolveRouteAlias(pathname);
  const routePathname = aliasPathname || pathname;

  const isPublicPath = publicPaths.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
  const isPublicApi = publicApiPrefixes.some(
    (prefix) => pathname.startsWith(prefix)
  );

  if (isPublicPath || isPublicApi) {
    return NextResponse.next();
  }

  const isProtectedPage = pageRoutes.some(
    (route) => routePathname === route || routePathname.startsWith(`${route}/`)
  );
  const isProtectedApi = apiRoutes.some(
    (prefix) => pathname.startsWith(prefix)
  );

  if (!isProtectedPage && !isProtectedApi) {
    return NextResponse.next();
  }

  const userId = request.cookies.get('voc_user_id')?.value;

  if (userId) {
    if (aliasPathname) {
      const aliasUrl = request.nextUrl.clone();
      aliasUrl.pathname = aliasPathname;
      return NextResponse.redirect(aliasUrl);
    }
    return NextResponse.next();
  }

  if (isProtectedApi) {
    return NextResponse.json({ success: false, error: '未登录' }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.searchParams.set('redirect', routePathname);
  return NextResponse.redirect(loginUrl);
}

function resolveRouteAlias(pathname: string): string | null {
  const alias = routeAliases.find(
    (route) => pathname === route.from || pathname.startsWith(`${route.from}/`)
  );

  if (!alias) return null;

  return `${alias.to}${pathname.slice(alias.from.length)}`;
}

export const config = {
  matcher: [
    '/',
    '/chatbi/:path*',
    '/data-prep/:path*',
    '/data-pere/:path*',
    '/voc_data_report/:path*',
    '/api/chat/:path*',
    '/api/users/:path*',
    '/api/audit/:path*',
    '/api/auth/:path*',
    '/api/logout/:path*',
    '/login/:path*',
  ],
};
