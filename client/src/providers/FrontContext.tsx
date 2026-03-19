import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import Front from '@frontapp/plugin-sdk';

// Types Front SDK (simplifié — le SDK ne fournit pas de types complets)
export interface FrontSingleConversationContext {
  type: 'singleConversation';
  conversation: {
    id: string;
    subject: string;
    status: string;
    assignee?: { id: string; email: string; name: string };
    recipient?: { handle: string; name?: string };
    inboxes?: { id: string; name: string; address?: string }[];
  };
  listMessages: () => Promise<{ results: { id: string; body: string; author?: { name?: string; email?: string }; date: number }[] }>;
  createDraft: (options: {
    content: { body: string; type: 'html' | 'text' };
    replyOptions?: { type: 'reply' | 'replyAll'; originalMessageId: string };
  }) => Promise<void>;
}

export interface FrontNoConversationContext {
  type: 'noConversation';
}

export interface FrontMultiConversationsContext {
  type: 'multiConversations';
}

export type FrontContext =
  | FrontSingleConversationContext
  | FrontNoConversationContext
  | FrontMultiConversationsContext
  | null;

const FrontContextValue = createContext<FrontContext>(null);

export function useFrontContext(): FrontContext {
  return useContext(FrontContextValue);
}

export function FrontContextProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<FrontContext>(null);

  useEffect(() => {
    const subscription = Front.contextUpdates.subscribe((ctx: unknown) => {
      setContext(ctx as FrontContext);
    });
    return () => subscription.unsubscribe();
  }, []);

  return (
    <FrontContextValue.Provider value={context}>
      {children}
    </FrontContextValue.Provider>
  );
}
