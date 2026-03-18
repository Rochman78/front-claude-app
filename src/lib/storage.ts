'use client';

import { Agent, SharedFile, ChatMessage } from '@/types';

const AGENTS_KEY = 'frontapp_agents';
const SHARED_FILES_KEY = 'frontapp_shared_files';
const CHAT_KEY_PREFIX = 'frontapp_chat_';

// Agents
export function getAgents(): Agent[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem(AGENTS_KEY);
  return data ? JSON.parse(data) : [];
}

export function getAgent(id: string): Agent | undefined {
  return getAgents().find((a) => a.id === id);
}

export function saveAgents(agents: Agent[]): void {
  localStorage.setItem(AGENTS_KEY, JSON.stringify(agents));
}

export function createAgent(name: string, email: string): Agent {
  const agents = getAgents();
  const agent: Agent = {
    id: crypto.randomUUID(),
    name,
    email,
    instructions: '',
    files: [],
    createdAt: new Date().toISOString(),
  };
  agents.push(agent);
  saveAgents(agents);
  return agent;
}

export function deleteAgent(id: string): void {
  const agents = getAgents().filter((a) => a.id !== id);
  saveAgents(agents);
}

export function updateAgent(agent: Agent): void {
  const agents = getAgents().map((a) => (a.id === agent.id ? agent : a));
  saveAgents(agents);
}

// Shared Files
export function getSharedFiles(): SharedFile[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem(SHARED_FILES_KEY);
  return data ? JSON.parse(data) : [];
}

export function saveSharedFiles(files: SharedFile[]): void {
  localStorage.setItem(SHARED_FILES_KEY, JSON.stringify(files));
}

export function addSharedFile(file: SharedFile): void {
  const files = getSharedFiles();
  files.push(file);
  saveSharedFiles(files);
}

export function deleteSharedFile(id: string): void {
  const files = getSharedFiles().filter((f) => f.id !== id);
  saveSharedFiles(files);
}

export function getSharedFilesForAgent(agentId: string): SharedFile[] {
  return getSharedFiles().filter(
    (f) => f.assignedTo === 'all' || (Array.isArray(f.assignedTo) && f.assignedTo.includes(agentId))
  );
}

// Chat
export function getChatMessages(key: string): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem(CHAT_KEY_PREFIX + key);
  return data ? JSON.parse(data) : [];
}

export function saveChatMessages(key: string, messages: ChatMessage[]): void {
  localStorage.setItem(CHAT_KEY_PREFIX + key, JSON.stringify(messages));
}
