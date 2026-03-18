import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-8">
      <h1 className="text-4xl font-bold text-white">FrontApp AI Agents</h1>
      <p className="text-gray-400 text-lg text-center max-w-xl">
        Plateforme de gestion d&apos;agents IA connectés à FrontApp. Configurez vos agents,
        gérez leurs bases de connaissances et traitez vos emails intelligemment.
      </p>
      <div className="flex gap-4">
        <Link
          href="/admin"
          className="rounded-lg bg-red-600 px-6 py-3 font-semibold text-white hover:bg-red-700 transition-colors"
        >
          Administration
        </Link>
        <Link
          href="/mailbox"
          className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 transition-colors"
        >
          Boîte Mail
        </Link>
      </div>
    </div>
  );
}
