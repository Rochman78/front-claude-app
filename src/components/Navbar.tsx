'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [userName, setUserName] = useState('');

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.name || d?.email) setUserName(d.name || d.email); })
      .catch(() => {});
  }, []);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  // Ne pas afficher la navbar sur /login
  if (pathname === '/login') return null;

  return (
    <nav className="sticky top-0 z-50 bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-8">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gray-900 flex items-center justify-center text-white font-bold text-xs">Z</div>
          <div>
            <div className="text-sm font-bold text-gray-900 leading-tight">FrontappAI</div>
            <div className="text-xs text-gray-400 leading-tight">by Zephyr O.S.C</div>
          </div>
        </Link>
        <Link
          href="/mailbox"
          className={`text-sm font-medium transition-colors ${
            pathname.startsWith('/mailbox') ? 'text-blue-600' : 'text-gray-500 hover:text-gray-800'
          }`}
        >
          Boite Mail
        </Link>
      </div>
      <div className="flex items-center gap-4">
        <Link
          href="/admin"
          className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
        >
          Administration
        </Link>
        {userName && (
          <div className="flex items-center gap-3 pl-4 border-l border-gray-200">
            <span className="text-xs text-gray-500">{userName}</span>
            <button
              onClick={handleLogout}
              className="text-xs text-gray-400 hover:text-red-600 transition-colors"
            >
              Deconnexion
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
