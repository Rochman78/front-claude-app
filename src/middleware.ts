import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth-edge';

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/register', '/api/auth/logout', '/plugin', '/api/plugin/'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Routes publiques — pas de vérification
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Fichiers statiques — pas de vérification
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon') || pathname.endsWith('.css') || pathname.endsWith('.js')) {
    return NextResponse.next();
  }

  // Vérifier le cookie de session
  const token = req.cookies.get('frontapp_session')?.value;
  if (!token) {
    // API → 401
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
    }
    // Pages → redirect login
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const session = await verifyToken(token);
  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Session expirée' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|plugin).*)'],
};
