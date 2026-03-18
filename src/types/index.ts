export interface Agent {
  id: string;
  name: string;
  email: string;
  instructions: string;
  files: AgentFile[];
  createdAt: string;
}

export interface AgentFile {
  id: string;
  name: string;
  content: string;
  createdAt: string;
}

export interface SharedFile {
  id: string;
  name: string;
  content: string;
  assignedTo: 'all' | string[]; // 'all' or array of agent IDs
  createdAt: string;
}

export interface EmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
}

export interface EmailThread {
  id: string;
  subject: string;
  participants: string[];
  messages: EmailMessage[];
  lastMessageDate: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}
