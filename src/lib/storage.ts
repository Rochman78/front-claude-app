'use client';

import { Agent, SharedFile, ChatMessage } from '@/types';

// Agents
export async function getAgents(): Promise<Agent[]> {
  const res = await fetch('/api/agents');
  return res.json();
}

export async function getAgent(id: string): Promise<Agent | undefined> {
  const res = await fetch(`/api/agents/${id}`);
  if (!res.ok) return undefined;
  return res.json();
}

export async function createAgent(name: string, email: string, inboxId: string): Promise<Agent> {
  const res = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, inboxId }),
  });
  return res.json();
}

export async function deleteAgent(id: string): Promise<void> {
  await fetch(`/api/agents/${id}`, { method: 'DELETE' });
}

export async function updateAgent(agent: Agent): Promise<void> {
  const res = await fetch(`/api/agents/${agent.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agent),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erreur serveur ${res.status}`);
  }
}

// Shared Files
export async function getSharedFiles(): Promise<SharedFile[]> {
  const res = await fetch('/api/shared-files');
  return res.json();
}

export async function addSharedFile(file: SharedFile): Promise<void> {
  await fetch('/api/shared-files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(file),
  });
}

export async function deleteSharedFile(id: string): Promise<void> {
  await fetch('/api/shared-files', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

export async function getSharedFilesForAgent(agentId: string): Promise<SharedFile[]> {
  const res = await fetch(`/api/shared-files?agentId=${agentId}`);
  return res.json();
}

// Chat (legacy key-based — kept for backward compat)
export async function getChatMessages(key: string): Promise<ChatMessage[]> {
  const res = await fetch(`/api/chat-messages?key=${encodeURIComponent(key)}`);
  return res.json();
}

export async function saveChatMessages(key: string, messages: ChatMessage[]): Promise<void> {
  await fetch('/api/chat-messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, messages }),
  });
}

// Conversations Claude (persistées en BDD)
export interface ClaudeConversation {
  id: string;
  agent_id: string;
  front_conversation_id: string;
  subject: string;
  status: string;
  created_at: string;
  updated_at: string;
  messages: { id: string; role: string; content: string; created_at: string }[];
}

export async function getOrCreateConversation(agentId: string, frontConvId: string, subject?: string): Promise<ClaudeConversation> {
  const params = new URLSearchParams({ agent_id: agentId, front_conversation_id: frontConvId });
  if (subject) params.set('subject', subject);
  const res = await fetch(`/api/conversations?${params}`);
  return res.json();
}

export async function addConversationMessage(conversationId: string, role: string, content: string): Promise<{ id: string; role: string; content: string; created_at: string }> {
  const res = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId, role, content }),
  });
  return res.json();
}

export async function clearConversationMessages(conversationId: string): Promise<void> {
  await fetch('/api/conversations', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId }),
  });
}
