'use client';

import { useEffect, useState } from 'react';
import { Clock, MessageSquareText } from 'lucide-react';
import type { Message } from '@/lib/types';
import type { SmartTableSelection } from './table-picker-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ChatHistorySession {
  id: string;
  title: string;
  selectedTableIds: string[];
  selectedTableNames: string[];
  updatedAt: string;
  messageCount: number;
  lastMessage: string;
}

export interface LoadedChatHistory {
  sessionId: string;
  title: string;
  selectedTables: SmartTableSelection[];
  messages: Message[];
}

interface ChatHistoryDialogProps {
  onSelectConversation: (history: LoadedChatHistory) => void;
}

export function ChatHistoryDialog({ onSelectConversation }: ChatHistoryDialogProps) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ChatHistorySession[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setIsLoading(true);
    setError('');

    fetch('/api/chat/history')
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.success) throw new Error(json.error || '历史记录加载失败');
        setSessions(json.data as ChatHistorySession[]);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '历史记录加载失败');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSelect = async (sessionId: string) => {
    setLoadingId(sessionId);
    setError('');

    try {
      const response = await fetch(`/api/chat/history/${sessionId}`);
      const json = await response.json();
      if (!json.success) throw new Error(json.error || '会话加载失败');

      const selectedTableIds = json.data.session.selectedTableIds as string[];
      const selectedTableNames = json.data.session.selectedTableNames as string[];
      const selectedTables = selectedTableIds.map((id, index) => ({
        id,
        name: selectedTableNames[index] || id,
        source_type: 'history',
      }));

      onSelectConversation({
        sessionId,
        title: String(json.data.session.title || '新对话'),
        selectedTables,
        messages: json.data.messages as Message[],
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '会话加载失败');
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <>
      <button className="voc-chip" onClick={() => setOpen(true)}>
        <Clock className="w-4 h-4" />
        历史记录
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="!max-w-[760px] rounded-[28px] border border-white/65 bg-white/72 p-7 shadow-[0_28px_90px_rgba(15,23,42,0.16)] backdrop-blur-2xl">
          <DialogHeader>
            <DialogTitle className="text-2xl font-extrabold text-slate-950">历史记录</DialogTitle>
          </DialogHeader>

          <div className="mt-2 text-sm text-slate-500">仅展示最近 30 天的智能问数会话</div>

          <div className="mt-5 max-h-[520px] overflow-y-auto pr-1">
            {isLoading && (
              <div className="rounded-2xl border border-white/70 bg-white/45 px-5 py-8 text-center text-sm text-slate-400">
                正在加载历史记录...
              </div>
            )}

            {!isLoading && error && (
              <div className="rounded-2xl border border-red-100 bg-red-50/70 px-5 py-4 text-sm text-red-500">
                {error}
              </div>
            )}

            {!isLoading && !error && sessions.length === 0 && (
              <div className="rounded-2xl border border-white/70 bg-white/45 px-5 py-8 text-center text-sm text-slate-400">
                暂无历史记录
              </div>
            )}

            {!isLoading && !error && sessions.length > 0 && (
              <div className="space-y-3">
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    className="group w-full rounded-2xl border border-white/65 bg-white/52 px-5 py-4 text-left shadow-[0_12px_34px_rgba(15,23,42,0.06)] backdrop-blur-xl transition hover:bg-white/82 hover:shadow-[0_18px_44px_rgba(15,23,42,0.10)]"
                    onClick={() => handleSelect(session.id)}
                    disabled={loadingId === session.id}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/78 text-blue-600 shadow-sm">
                        <MessageSquareText className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-4">
                          <div className="truncate text-[15px] font-bold text-slate-800">
                            {session.title}
                          </div>
                          <div className="shrink-0 text-xs text-slate-400">
                            {formatDate(session.updatedAt)}
                          </div>
                        </div>
                        <div className="mt-1 truncate text-sm text-slate-500">
                          {session.lastMessage || '暂无消息'}
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                          <span>{session.messageCount} 条消息</span>
                          {session.selectedTableNames.slice(0, 3).map((name) => (
                            <span
                              key={name}
                              className="rounded-full border border-slate-200/70 bg-white/55 px-2 py-1"
                            >
                              {name}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}
