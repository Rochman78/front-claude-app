'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function Navbar() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-50 flex items-center justify-between bg-gray-900 border-b border-gray-700 px-6 py-3">
      <div className="flex items-center gap-6">
        <Link href="/" className="text-xl font-bold text-white">
          FrontApp AI
        </Link>
        <Link
          href="/mailbox"
          className={`text-sm font-medium transition-colors ${
            pathname.startsWith('/mailbox')
              ? 'text-blue-400'
              : 'text-gray-300 hover:text-white'
          }`}
        >
          Boîte Mail
        </Link>
      </div>
      <Link
        href="/admin"
        className="rounded-md bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 transition-colors"
      >
        ADMIN
      </Link>
    </nav>
  );
}
