import Link from 'next/link';

export default function AdminPage() {
  return (
    <div className="max-w-2xl mx-auto py-10">
      <h1 className="text-3xl font-bold text-white mb-8">Administration</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Link
          href="/admin/agents"
          className="flex flex-col items-center gap-3 rounded-xl bg-gray-800 p-8 hover:bg-gray-700 transition-colors border border-gray-700"
        >
          <svg className="w-10 h-10 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span className="text-lg font-semibold text-white">Gestion des agents</span>
          <span className="text-sm text-gray-400">Créer, modifier et configurer vos agents IA</span>
        </Link>
        <Link
          href="/admin/shared-files"
          className="flex flex-col items-center gap-3 rounded-xl bg-gray-800 p-8 hover:bg-gray-700 transition-colors border border-gray-700"
        >
          <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          <span className="text-lg font-semibold text-white">Fichiers partagés</span>
          <span className="text-sm text-gray-400">Gérer les fichiers partagés entre agents</span>
        </Link>
      </div>
    </div>
  );
}
