'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { Message } from '@/lib/types';
import { HomeView } from '@/components/home-view';
import { ChatView } from '@/components/chat-view';
import type { SmartTableSelection } from '@/components/table-picker-dialog';
import type { LoadedChatHistory } from '@/components/chat-history-dialog';

type ViewMode = 'home' | 'chat';

export default function VocChatLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const [view, setView] = useState<ViewMode>('home');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedSmartTables, setSelectedSmartTables] = useState<SmartTableSelection[]>([]);
  const [isReasoning, setIsReasoning] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionTitle, setActiveSessionTitle] = useState('新对话');
  const [contextWarning, setContextWarning] = useState(false);
  const hasLoadedRouteSessionRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const loadConversation = useCallback(async (sessionId: string) => {
    const response = await fetch(`/api/chat/history/${sessionId}`);
    const json = await response.json();
    if (!json.success) throw new Error(json.error || '会话加载失败');

    const selectedTableIds = json.data.session.selectedTableIds as string[];
    const selectedTableNames = json.data.session.selectedTableNames as string[];
    setActiveSessionId(sessionId);
    setActiveSessionTitle(json.data.session.title || '新对话');
    setSelectedSmartTables(selectedTableIds.map((id, index) => ({
      id,
      name: selectedTableNames[index] || id,
      source_type: 'history',
    })));
    setMessages(json.data.messages as Message[]);
    setIsStreaming(false);
    setView('chat');
  }, []);

  useEffect(() => {
    const routeSessionId = typeof params?.id === 'string' ? params.id : '';
    if (!routeSessionId || hasLoadedRouteSessionRef.current) return;

    hasLoadedRouteSessionRef.current = true;
    loadConversation(routeSessionId).catch(() => {
      router.replace('/chatbi');
    });
  }, [loadConversation, params, router]);

  useEffect(() => {
    if (!activeSessionId) return;
    let stale = false;
    const saveThinking = () => {
      if (stale) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === 'streaming-marker' ? { ...m, timestamp: Date.now() } : m))
      );
    };
    window.addEventListener('beforeunload', saveThinking);
    return () => {
      stale = true;
      window.removeEventListener('beforeunload', saveThinking);
    };
  }, [activeSessionId]);

  const sendMessage = useCallback(
    async (query: string) => {
      if (isStreaming || !query.trim()) return;

      setView('chat');
      let conversationIdForRequest = activeSessionId;
      const nextTitle = buildSessionTitle(query);
      if (!activeSessionId && messages.length === 0) {
        setActiveSessionTitle(nextTitle);
        conversationIdForRequest = await createChatSession({
          title: nextTitle,
          selectedTables: selectedSmartTables,
        });
        if (conversationIdForRequest) {
          hasLoadedRouteSessionRef.current = true;
          setActiveSessionId(conversationIdForRequest);
          window.history.replaceState(null, '', `/chatbi/${conversationIdForRequest}`);
        }
      }

      const userMsg: Message = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: query,
        timestamp: Date.now(),
      };

      const assistantId = `assistant-${Date.now()}`;
      const assistantMsg: Message = {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        thinking: isReasoning ? '' : undefined,
        sql: '',
        sources: selectedSmartTables.length > 0
          ? selectedSmartTables.map((table) => table.name)
          : [],
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            isReasoning,
            conversationId: conversationIdForRequest,
            smartTableIds: selectedSmartTables.map((table) => table.id),
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error('Failed to connect to AI service');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = '';
        let thinkingContent = '';
        let mainContent = '';
        let isInThinking = false;
        const progressPhases = new Map<string, string>();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

            try {
              const data = JSON.parse(line.slice(6));
              if (data.error) {
                accumulated += `\n\n[Error: ${data.error}]`;
                break;
              }
              if (data.sessionId && typeof data.sessionId === 'string') {
                setActiveSessionId(data.sessionId);
                const currentPath = window.location.pathname;
                const expectedPath = `/chatbi/${data.sessionId}`;
                if (currentPath !== expectedPath) {
                  hasLoadedRouteSessionRef.current = true;
                  window.history.replaceState(null, '', expectedPath);
                }
              }
              if (data.contextWarning === true) {
                setContextWarning(true);
              }
              if (Array.isArray(data.followUps)) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? {
                          ...m,
                          followUps: data.followUps.map((item: unknown) => String(item)).filter(Boolean),
                        }
                      : m
                  )
                );
              }
              if (data.thinking || data.sql || data.pythonCode || data.report || data.chart) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? {
                          ...m,
                          thinking: typeof data.thinking === 'string' ? (m.thinking && m.thinking.trim() ? m.thinking : data.thinking) : m.thinking,
                          sql: typeof data.sql === 'string' ? data.sql : m.sql,
                          pythonCode: typeof data.pythonCode === 'string' ? data.pythonCode : m.pythonCode,
                          report: data.report && typeof data.report === 'object' ? data.report : m.report,
                          chart: data.chart && typeof data.chart === 'object' ? data.chart : m.chart,
                        }
                      : m
                  )
                );
              }
              if (data.content) {
                if (data.progressPhase) {
                  const phase = data.progressPhase as string;
                  const text = data.content.replace(/\n$/, '');
                  if (phase === 'sql' || phase === 'python') {
                    progressPhases.set(phase, text);
                  } else {
                    let prev = progressPhases.get('thinking') || '';
                    prev = prev.replace(/\n?思考中\.\.\.[ \t]*$/, '');
                    progressPhases.set('thinking', prev ? `${prev}\n${text}` : text);
                  }
                  const thinkingText = Array.from(progressPhases.entries())
                    .map(([, t]) => t)
                    .join('\n');
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, thinking: thinkingText }
                        : m
                    )
                  );
                  if (data.sql && typeof data.sql === 'string') {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantId
                          ? { ...m, sql: data.sql }
                          : m
                      )
                    );
                  }
                  if (data.pythonCode && typeof data.pythonCode === 'string') {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantId
                          ? { ...m, pythonCode: data.pythonCode }
                          : m
                      )
                    );
                  }
                } else {
                  accumulated += data.content;

                  if (isReasoning) {
                    const thinkMatch = accumulated.match(/<think([\s\S]*?)>([\s\S]*?)<\/think>/);
                    if (thinkMatch) {
                      thinkingContent = thinkMatch[2].trim();
                      mainContent = accumulated.replace(/<think[\s\S]*?<\/think>/, '').trim();
                    } else if (accumulated.includes('<think') && !accumulated.includes('</think')) {
                      const thinkStart = accumulated.indexOf('<think');
                      thinkingContent = accumulated.slice(thinkStart).replace(/<[^>]*>/, '').trim();
                      isInThinking = true;
                    } else {
                      mainContent = accumulated.trim();
                    }
                  } else {
                    mainContent = accumulated.trim();
                  }

                  let displayContent = mainContent;
                  let sqlPreview = '';
                  const sqlMatch = mainContent.match(/```sql\s*\n?([\s\S]*?)```/i);
                  if (sqlMatch) {
                    sqlPreview = sqlMatch[1].trim();
                    displayContent = mainContent
                      .replace(sqlMatch[0], '')
                      .replace(/\n?\s*(?:已执行\s*)?SQL\s*(?:查询|预览)?\s*[:：]\s*$/i, '')
                      .trim();
                  }

                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? {
                            ...m,
                            content: displayContent || mainContent,
                            thinking: thinkingContent || m.thinking || undefined,
                            sql: typeof data.sql === 'string' ? data.sql : (sqlPreview || m.sql || undefined),
                          }
                        : m
                    )
                  );
                }
              }
            } catch {
              // Skip malformed JSON chunks
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name !== 'AbortError') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content || '抱歉，连接出现问题，请稍后重试。' }
                : m
            )
          );
        }
      } finally {
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    },
    [activeSessionId, isStreaming, isReasoning, messages, router, selectedSmartTables]
  );

  const handleBackToHome = useCallback(() => {
    setView('home');
    setMessages([]);
    setActiveSessionId(null);
    setActiveSessionTitle('新对话');
    setContextWarning(false);
    setIsStreaming(false);
    hasLoadedRouteSessionRef.current = false;
    router.replace('/chatbi');
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, [router]);

  const handleStopStreaming = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setMessages((prev) => {
      const next = [...prev];
      const lastAssistantIndex = next.findLastIndex((message) => message.role === 'assistant');
      if (lastAssistantIndex >= 0) {
        next.splice(lastAssistantIndex, 1);
      }
      const lastUserIndex = next.findLastIndex((message) => message.role === 'user');
      if (lastUserIndex >= 0) {
        next.splice(lastUserIndex, 1);
      }
      return next;
    });
  }, []);

  const handleHistorySelect = useCallback((history: LoadedChatHistory) => {
    setActiveSessionId(history.sessionId);
    setActiveSessionTitle(history.title || '新对话');
    setSelectedSmartTables(history.selectedTables);
    setMessages(history.messages);
    setIsStreaming(false);
    setView('chat');
    router.replace(`/chatbi/${history.sessionId}`);
  }, [router]);

  const handleSessionDeleted = useCallback(() => {
    setView('home');
    setMessages([]);
    setActiveSessionId(null);
    setActiveSessionTitle('新对话');
    setContextWarning(false);
    setIsStreaming(false);
    hasLoadedRouteSessionRef.current = false;
    router.replace('/chatbi');
  }, [router]);

  const handleClearSession = useCallback(async () => {
    if (activeSessionId) {
      await fetch(`/api/chat/history/${activeSessionId}/messages`, { method: 'DELETE' }).catch(() => undefined);
    }
    setMessages([]);
    setContextWarning(false);
    setIsStreaming(false);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, [activeSessionId]);

  if (view === 'home') {
    return (
      <>
        <HomeView
          selectedSmartTables={selectedSmartTables}
          isReasoning={isReasoning}
          onSmartTablesChange={setSelectedSmartTables}
          onHistorySelect={handleHistorySelect}
          onReasoningToggle={() => setIsReasoning((prev) => !prev)}
          onSend={sendMessage}
          onSuggestionClick={sendMessage}
        />
        {children}
      </>
    );
  }

  return (
    <>
      <ChatView
        messages={messages}
        isStreaming={isStreaming}
        isReasoning={isReasoning}
        contextWarning={contextWarning}
        onClearContextWarning={() => setContextWarning(false)}
        selectedSmartTables={selectedSmartTables}
        sessionId={activeSessionId}
        sessionTitle={activeSessionTitle}
        onSessionTitleChange={setActiveSessionTitle}
        onSessionDeleted={handleSessionDeleted}
        onClearSession={handleClearSession}
        onSmartTablesChange={setSelectedSmartTables}
        onReasoningToggle={() => setIsReasoning((prev) => !prev)}
        onSend={sendMessage}
        onStopStreaming={handleStopStreaming}
        onBack={handleBackToHome}
        onSuggestionClick={sendMessage}
      />
      {children}
    </>
  );
}

function buildSessionTitle(query: string) {
  const compact = query.trim().replace(/\s+/g, ' ');
  return compact.length > 40 ? `${compact.slice(0, 40)}...` : compact || '新对话';
}

async function createChatSession({
  title,
  selectedTables,
}: {
  title: string;
  selectedTables: SmartTableSelection[];
}): Promise<string | null> {
  try {
    const response = await fetch('/api/chat/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        selectedTableIds: selectedTables.map((table) => table.id),
        selectedTableNames: selectedTables.map((table) => table.name),
      }),
    });
    const json = await response.json();
    return json.success && json.data?.id ? String(json.data.id) : null;
  } catch {
    return null;
  }
}
