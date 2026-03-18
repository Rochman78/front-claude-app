'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Agent, EmailThread } from '@/types';
import { getAgent } from '@/lib/storage';
import { mockThreads } from '@/lib/mock-emails';

export default function AgentMailboxPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [threads] = useState<EmailThread[]>(mockThreads);

  useEffect(() => {
    getAgent(agentId).then((a) => {
      if (a) setAgent(a);
    });
  }, [agentId]);

  if (!agent) {
    return <div className="py-10 text-center text-gray-500">Agent introuvable</div>;
  }

  return (
    <div className="max-w-4xl mx-auto py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Boîte mail — {agent.name}</h1>
        <p className="text-gray-400">{agent.email}</p>
      </div>

      <div className="flex flex-col gap-3">
        {threads.map((thread) => (
          <Link
            key={thread.id}
            href={`/mailbox/${agentId}/thread/${thread.id}`}
            className="rounded-xl bg-gray-800 p-4 border border-gray-700 hover:border-blue-500 transition-colors"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="font-semibold text-white">{thread.subject}</div>
                <div className="text-sm text-gray-400 mt-1">
                  {thread.participants.join(', ')}
                </div>
                <div className="text-sm text-gray-500 mt-1">
                  {thread.messages.length} message{thread.messages.length > 1 ? 's' : ''}
                </div>
              </div>
              <div className="text-xs text-gray-500">
                {new Date(thread.lastMessageDate).toLocaleDateString('fr-FR')}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
