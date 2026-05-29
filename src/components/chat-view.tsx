'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Message } from '@/lib/types';
import { FOLLOW_UP_VARIANTS } from '@/lib/types';
import {
  Settings,
  Sparkles,
  ArrowRight,
  Brain,
  ArrowLeft,
  BookOpen,
  Eye,
  EyeOff,
  Code2,
  Square,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  MessageSquareText,
  MoreHorizontal,
  Trash2,
  Pencil,
  Share2,
  Eraser,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TablePickerDialog, type SmartTableSelection } from './table-picker-dialog';
import { ProfileDialog } from './profile-dialog';
import { ReportView } from './report-view';
import { ChartCard } from './chart-card';
import { useAuthProfile } from '@/components/auth-provider';
import { usePinyinInitial } from '@/hooks/use-pinyin-initial';
import { GlassConfirmDialog } from './glass-confirm-dialog';
import { MarkdownRenderer } from './markdown-renderer';

interface ChatViewProps {
  messages: Message[];
  isStreaming: boolean;
  isReasoning: boolean;
  contextWarning?: boolean;
  onClearContextWarning?: () => void;
  selectedSmartTables: SmartTableSelection[];
  sessionId: string | null;
  sessionTitle: string;
  onSessionTitleChange: (title: string) => void;
  onSessionDeleted: () => void;
  onClearSession: () => void;
  onSmartTablesChange: (tables: SmartTableSelection[]) => void;
  onReasoningToggle: () => void;
  onSend: (query: string) => void;
  onStopStreaming: () => void;
  onBack: () => void;
  onSuggestionClick: (query: string) => void;
}

interface PreviewPayload {
  table: {
    id: string;
    name: string;
    physical_table_name: string;
  };
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export function ChatView({
  messages,
  isStreaming,
  isReasoning,
  contextWarning,
  onClearContextWarning,
  selectedSmartTables,
  sessionId,
  sessionTitle,
  onSessionTitleChange,
  onSessionDeleted,
  onClearSession,
  onSmartTablesChange,
  onReasoningToggle,
  onSend,
  onStopStreaming,
  onBack,
  onSuggestionClick,
}: ChatViewProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [expandedSqlIds, setExpandedSqlIds] = useState<Set<string>>(new Set());
  const [expandedPythonIds, setExpandedPythonIds] = useState<Set<string>>(new Set());
  const [expandedUserIds, setExpandedUserIds] = useState<Set<string>>(new Set());
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const { profile: userProfile, updateProfileCache } = useAuthProfile();
  const profileInitial = usePinyinInitial(userProfile?.accountName || userProfile?.account);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(sessionTitle);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewData, setPreviewData] = useState<PreviewPayload | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isEditingTitle) setDraftTitle(sessionTitle);
  }, [isEditingTitle, sessionTitle]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (query.trim() && !isStreaming) {
      onSend(query.trim());
      setQuery('');
    }
  };

  const handleStop = () => {
    const lastUserQuery = [...messages].reverse().find((message) => message.role === 'user')?.content;
    if (lastUserQuery) setQuery(lastUserQuery);
    onStopStreaming();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isStreaming) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSaveTitle = async () => {
    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      setDraftTitle(sessionTitle);
      setIsEditingTitle(false);
      return;
    }

    onSessionTitleChange(nextTitle);
    setIsEditingTitle(false);

    if (!sessionId) return;

    setIsSavingTitle(true);
    try {
      const response = await fetch(`/api/chat/history/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: nextTitle }),
      });
      const json = await response.json();
      if (json.success && json.data?.title) {
        onSessionTitleChange(String(json.data.title));
      }
    } catch {
      onSessionTitleChange(sessionTitle);
    } finally {
      setIsSavingTitle(false);
    }
  };

  const handleTitleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSaveTitle();
    }
    if (event.key === 'Escape') {
      setDraftTitle(sessionTitle);
      setIsEditingTitle(false);
    }
  };

  const handleDeleteSession = async () => {
    if (!sessionId) {
      onSessionDeleted();
      return;
    }

    const response = await fetch(`/api/chat/history/${sessionId}`, { method: 'DELETE' });
    const json = await response.json().catch(() => ({ success: false }));
    if (json.success) {
      onSessionDeleted();
    }
    setShowDeleteConfirm(false);
  };

  const handleShareSession = async () => {
    if (!sessionId) return;
    const url = `${window.location.origin}/chatbi/${sessionId}`;
    await navigator.clipboard?.writeText(url);
  };

  const openTablePreview = async (table: SmartTableSelection) => {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewError('');
    setPreviewData(null);

    try {
      const response = await fetch(`/api/smart-table/${table.id}/preview`);
      const json = await response.json();
      if (json.success) {
        setPreviewData(json.data as PreviewPayload);
      } else {
        setPreviewError(json.error || '预览失败');
      }
    } catch {
      setPreviewError('预览失败，请稍后重试');
    } finally {
      setPreviewLoading(false);
    }
  };

  const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');

  const toggleSqlPreview = (messageId: string) => {
    setExpandedSqlIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  const togglePythonPreview = (messageId: string) => {
    setExpandedPythonIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  const toggleUserMessage = (messageId: string) => {
    setExpandedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  return (
    <div className="voc-page-bg min-h-screen relative flex flex-col">
      {/* Topbar - frosted glass */}
      <header className="voc-topbar sticky top-0 z-30 h-[92px] flex items-center px-8">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-slate-500 hover:text-slate-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="text-sm font-semibold">返回</span>
        </button>

        <div className="ml-5 flex w-[390px] min-w-0 items-center gap-2">
          {isEditingTitle ? (
            <>
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onKeyDown={handleTitleKeyDown}
                autoFocus
                className="h-9 min-w-0 flex-1 rounded-full border border-white/70 bg-white/70 px-4 text-sm font-bold text-slate-800 shadow-sm outline-none backdrop-blur-xl focus:border-blue-300 focus:ring-2 focus:ring-blue-200/60"
                placeholder="请输入会话标题"
              />
              <button
                type="button"
                onClick={handleSaveTitle}
                disabled={isSavingTitle}
                className="grid h-8 w-8 place-items-center rounded-full bg-blue-500 text-white shadow-sm transition hover:bg-blue-600 disabled:opacity-60"
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftTitle(sessionTitle);
                  setIsEditingTitle(false);
                }}
                className="grid h-8 w-8 place-items-center rounded-full bg-white/60 text-slate-500 shadow-sm transition hover:bg-white/85 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-2 bg-transparent px-1 py-2 text-left text-slate-800">
                <MessageSquareText className="h-4 w-4 shrink-0 text-blue-500/85" />
                <span className="truncate text-sm font-extrabold">{sessionTitle || '新对话'}</span>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-transparent text-slate-400 transition hover:bg-white/55 hover:text-slate-700"
                    title="对话操作"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[150px] rounded-2xl border-white/70 bg-white/86 p-2 shadow-[0_18px_52px_rgba(15,23,42,0.14)] backdrop-blur-xl">
                  <DropdownMenuItem onClick={() => setIsEditingTitle(true)} className="rounded-xl">
                    <Pencil className="h-4 w-4" />
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleShareSession} disabled={!sessionId} className="rounded-xl">
                    <Share2 className="h-4 w-4" />
                    分享
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setShowDeleteConfirm(true)} variant="destructive" className="rounded-xl">
                    <Trash2 className="h-4 w-4" />
                    删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>

        <TablePickerDialog
          triggerClassName="voc-chip mx-auto"
          triggerStyle={{ height: 48, fontSize: 15, padding: '0 0' }}
          selectedTables={selectedSmartTables}
          onSelectedTablesChange={onSmartTablesChange}
        />

        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => router.push('/data-prep')} className="w-10 h-10 rounded-full bg-white/50 flex items-center justify-center text-slate-500 backdrop-blur-sm hover:bg-white/80 transition-all">
                <Settings className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">系统设置</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="w-10 h-10 rounded-full bg-white/50 flex items-center justify-center text-slate-500 backdrop-blur-sm hover:bg-white/80 transition-all">
                <BookOpen className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">知识库</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => setIsProfileOpen(true)} className="w-12 h-12 rounded-full object-cover shadow-sm cursor-pointer select-none ml-8 overflow-hidden hover:ring-2 hover:ring-[#6366f1]/40 transition-all">
                {userProfile?.avatar ? (
                  <img src={userProfile.avatar} alt="用户头像" className="w-full h-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#1f6bff] via-[#65c8df] to-[#35d07f] text-base font-extrabold text-white">
                    {profileInitial}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">个人中心</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {/* 个人资料弹窗 */}
      <ProfileDialog
        open={isProfileOpen}
        onOpenChange={setIsProfileOpen}
        profile={userProfile}
        onProfileChange={updateProfileCache}
      />

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex !h-[calc(100vh-48px)] !max-h-[calc(100vh-48px)] !w-[calc(100vw-48px)] !max-w-[calc(100vw-48px)] flex-col gap-0 overflow-hidden rounded-[24px] border-white/60 bg-white/90 p-0 shadow-[0_24px_80px_rgba(15,23,42,0.18)] backdrop-blur-2xl sm:!max-w-[calc(100vw-48px)]">
          <DialogHeader className="shrink-0 border-b border-slate-100/80 px-7 py-6">
            <div className="flex items-center justify-between pr-8">
              <div>
                <DialogTitle className="text-[22px] font-extrabold tracking-tight text-slate-950">
                  预览数据表
                </DialogTitle>
                {previewData?.table.name && (
                  <DialogDescription className="mt-1 text-sm text-slate-500">
                    {previewData.table.name}
                  </DialogDescription>
                )}
              </div>
            </div>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col px-7 py-6">
            {previewLoading ? (
              <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                加载预览数据...
              </div>
            ) : previewError ? (
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm font-semibold text-rose-500">
                {previewError}
              </div>
            ) : !previewData || previewData.rows.length === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate-400">
                暂无数据
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="min-h-0 w-full flex-1 overflow-auto rounded-2xl border border-slate-100 bg-white/72 [scrollbar-gutter:stable]">
                  <table className="w-full border-separate border-spacing-0 text-left text-xs">
                    <thead>
                      <tr>
                        {previewData.columns.map((column) => (
                          <th
                            key={column}
                            className="sticky top-0 z-30 whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 font-bold text-slate-500 shadow-[0_1px_0_rgba(226,232,240,0.95),0_12px_20px_rgba(15,23,42,0.08)]"
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="[&_tr:first-child_td]:pt-3">
                      {previewData.rows.map((row, rowIndex) => (
                        <tr key={`${previewData.table.id}-${rowIndex}`} className="hover:bg-slate-50/80">
                          {previewData.columns.map((column) => (
                            <td
                              key={column}
                              className="whitespace-nowrap border-b border-slate-100 bg-white/72 px-3 py-2 text-slate-700"
                              title={String(row[column] ?? '')}
                            >
                              <span className="block truncate max-w-[220px]">{String(row[column] ?? '')}</span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="shrink-0 border-t border-slate-100/80 pt-3 text-left text-xs text-slate-400">
                  仅显示前20行数据
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Chat area */}
      <main className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-[1100px] mx-auto relative">
          {/* Aura */}
          <div className="voc-aura voc-aura-mint" style={{ right: '-5%', top: '0', width: 280, height: 200, opacity: 0.48 }} />
          <div className="voc-aura voc-aura-lavender" style={{ left: '-10%', bottom: '10%', width: 360, height: 200, opacity: 0.4 }} />

          {/* Messages */}
          {contextWarning && (
            <div className="mb-5 flex items-center gap-3 rounded-2xl border border-amber-200/70 bg-amber-50/70 px-5 py-3.5 backdrop-blur-sm">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
              <div className="flex-1 text-sm text-amber-800">
                <span className="font-semibold">对话上下文已累计较长</span>
                <span className="text-amber-600">，可能影响模型回答准确性。建议开启新对话以获得最佳体验。</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  onClearContextWarning?.();
                  onClearSession?.();
                }}
                className="shrink-0 rounded-xl bg-amber-500/15 px-4 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-500/25"
              >
                新对话
              </button>
            </div>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className="voc-animate-in mb-6">
              {msg.role === 'user' ? (
                <div className="flex items-start justify-end gap-3">
                  <UserMessageBubble
                    message={msg}
                    expanded={expandedUserIds.has(msg.id)}
                    onToggle={() => toggleUserMessage(msg.id)}
                  />
                  {userProfile?.avatar ? (
                    <img 
                      src={userProfile.avatar} 
                      alt="用户头像" 
                      className="mt-1 h-10 w-10 shrink-0 rounded-full object-cover shadow-[0_10px_24px_rgba(15,23,42,0.12)] ring-4 ring-white/45"
                    />
                  ) : (
                    <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#1f6bff] via-[#65c8df] to-[#35d07f] text-sm font-extrabold text-white shadow-[0_10px_24px_rgba(15,23,42,0.12)] ring-4 ring-white/45">
                      {profileInitial}
                    </span>
                  )}
                </div>
              ) : (
                <div className={`voc-glass-strong rounded-[20px] p-6 relative ${msg.report ? 'max-w-[1040px]' : 'max-w-[890px]'}`}>
                  {/* AI avatar and title */}
                  <div className="flex items-start gap-4 mb-4">
                    <div className="voc-ai-badge voc-ai-badge-sm">
                      <Sparkles className="w-4 h-4" />
                    </div>
                    <div className="flex-1">
                      {msg.thinking ? (
                        <div className="voc-thought-bubble">
                          <div className="flex items-center gap-2 mb-2 font-semibold text-sm">
                            <Brain className="w-3.5 h-3.5" />
                            推理过程
                          </div>
                          <div className="whitespace-pre-wrap text-[13px] leading-relaxed opacity-90">
                            {msg.thinking}
                          </div>
                        </div>
                      ) : (
                        <>
                          <h2 className="text-xl font-extrabold text-slate-950 mb-1">分析结论</h2>
                          <MarkdownRenderer
                            content={msg.content}
                            showCursor={isStreaming && msg.id === lastAssistantMsg?.id}
                          />
                        </>
                      )}
                    </div>
                  </div>

                  {/* Source line */}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-4 ml-14">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-extrabold text-slate-400">数据来源：</span>
                        {resolveSourceTables(msg.sources, selectedSmartTables).map((source) => (
                          source.table ? (
                            <button
                              key={source.name}
                              type="button"
                              onClick={() => openTablePreview(source.table as SmartTableSelection)}
                              className="voc-source-badge transition hover:bg-white/85 hover:text-slate-700"
                              title="预览数据源"
                            >
                              <span className="voc-status-dot" style={{ width: 8, height: 8 }} />
                              {source.name}
                            </button>
                          ) : (
                            <span key={source.name} className="voc-source-badge">
                              <span className="voc-status-dot" style={{ width: 8, height: 8 }} />
                              {source.name}
                            </span>
                          )
                        ))}
                      </div>
                      {msg.sql && (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleSqlPreview(msg.id)}
                            className="mt-3 inline-flex h-9 items-center gap-2 rounded-full border border-white/70 bg-white/60 px-3 text-xs font-semibold text-slate-500 shadow-[0_8px_22px_rgba(15,23,42,0.05)] backdrop-blur-xl transition hover:bg-white/85 hover:text-slate-700"
                          >
                            {expandedSqlIds.has(msg.id) ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                            SQL 预览
                          </button>
                          {(expandedSqlIds.has(msg.id) || (isStreaming && msg.id === lastAssistantMsg?.id)) && (
                            <div className="mt-3 rounded-2xl border border-white/60 bg-white/55 p-4 shadow-[0_12px_32px_rgba(15,23,42,0.06)] backdrop-blur-xl">
                              <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-600">
                                {msg.sql}
                              </pre>
                            </div>
                          )}
                        </>
                      )}
                      {msg.pythonCode && (
                        <>
                          <button
                            type="button"
                            onClick={() => togglePythonPreview(msg.id)}
                            className="ml-2 mt-3 inline-flex h-9 items-center gap-2 rounded-full border border-white/70 bg-white/60 px-3 text-xs font-semibold text-slate-500 shadow-[0_8px_22px_rgba(15,23,42,0.05)] backdrop-blur-xl transition hover:bg-white/85 hover:text-slate-700"
                          >
                            <Code2 className="h-3.5 w-3.5" />
                            Python 代码
                          </button>
                          {(expandedPythonIds.has(msg.id) || (isStreaming && msg.id === lastAssistantMsg?.id)) && (
                            <div className="mt-3 rounded-2xl border border-white/60 bg-white/55 p-4 shadow-[0_12px_32px_rgba(15,23,42,0.06)] backdrop-blur-xl">
                              <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-600">
                                {msg.pythonCode}
                              </pre>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {msg.report && !(isStreaming && msg.id === lastAssistantMsg?.id) && (
                    <div className="ml-14">
                      <ReportView report={msg.report} />
                    </div>
                  )}

                  {msg.chart && !(isStreaming && msg.id === lastAssistantMsg?.id) && (
                    <div className="ml-14 flex flex-col gap-4">
                      <ChartCard data={msg.chart} />
                      <div className="rounded-[22px] border border-white/65 bg-white/52 p-5 shadow-[0_18px_48px_rgba(15,23,42,0.06)] backdrop-blur-xl">
                        <div className="mb-3 text-[15px] font-extrabold text-[#0066CC]">{msg.chart.title || '图表'} 解读</div>
                        <div className="text-[14px] leading-7 text-[#333333]">
                          <MarkdownRenderer content={msg.content || '暂无解读内容，请查看图表数据。'} />
                        </div>
                      </div>
                      <div className="text-xs font-medium text-slate-400">
                        以上分析结论基于数据表前1万行数据，AI 内容仅供参考，请理性辨别。
                      </div>
                    </div>
                  )}

                  {!msg.report && !msg.chart && !(isStreaming && msg.id === lastAssistantMsg?.id) && msg.content && (
                    <div className="mt-4 ml-14 text-xs font-medium text-slate-400">
                      以上分析结论基于数据表前1万行数据，AI 内容仅供参考，请理性辨别。
                    </div>
                  )}

                  {/* Streaming loading indicator */}
                  {isStreaming && msg.id === lastAssistantMsg?.id && !msg.content && !msg.thinking && (
                    <div className="ml-14 flex items-center gap-2 text-slate-400">
                      <div className="flex gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                      <span className="text-sm">正在分析...</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {messages.length > 0 && !isStreaming && (
            <div className="my-8 flex items-center justify-center gap-8 text-slate-300">
              <div className="h-px w-36 bg-slate-200/70" />
              <button
                type="button"
                onClick={onClearSession}
                className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wide transition hover:text-slate-500"
              >
                <span>以上为历史会话，</span>
                <Eraser className="h-3 w-3" />
                <span>点击清空会话</span>
              </button>
              <div className="h-px w-36 bg-slate-200/70" />
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
      </main>

      {/* Follow-up panel + Bottom input */}
      <div className="sticky bottom-0 z-20">
        {/* Follow-up suggestions - only show after response */}
        {lastAssistantMsg && !isStreaming && (lastAssistantMsg.followUps?.length || 0) > 0 && (
          <div className="flex justify-center gap-3 mb-4">
            {lastAssistantMsg.followUps?.map((label, index) => (
              <button
                key={label}
                className={`voc-suggestion voc-suggestion-${FOLLOW_UP_VARIANTS[index % FOLLOW_UP_VARIANTS.length]}`}
                onClick={() => onSuggestionClick(label)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Input bar */}
        <div className="px-8 pb-6">
          <div
            className={`voc-glass-input rounded-[28px] mx-auto max-w-[800px] h-[72px] flex items-center px-8 transition-all duration-300 ${
              isReasoning ? 'voc-reasoning-glow' : ''
            } ${isFocused && !isReasoning ? 'ring-2 ring-purple-400/40' : ''}`}
          >
            <Sparkles className="w-[18px] h-[18px] text-purple-600 mr-4 flex-shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="请输入您的查询需求"
              className="flex-1 bg-transparent outline-none text-base text-slate-600 placeholder:text-slate-400"
            />
            {/* Reasoning toggle - inside input box, right side before send */}
            <button
              className={`flex items-center gap-1.5 mr-3 px-3 py-2 rounded-full border transition-all duration-200 ${
                isReasoning
                  ? 'border-purple-300/60 bg-purple-50/80 text-purple-600'
                  : 'border-gray-200/80 bg-white/58 text-slate-400 hover:text-slate-600 hover:bg-white/80'
              }`}
              onClick={onReasoningToggle}
              title={isReasoning ? '关闭推理模式' : '开启推理模式'}
            >
              <Brain className={`w-3.5 h-3.5 ${isReasoning ? 'voc-heartbeat' : ''}`} />
              <span className="text-xs font-semibold">
                {isReasoning ? '深度推理' : '快速模式'}
              </span>
            </button>
            <button
              className={`voc-send-btn ${!query.trim() && !isStreaming ? 'opacity-50 cursor-not-allowed' : ''}`}
              onClick={isStreaming ? handleStop : handleSend}
              disabled={!query.trim() && !isStreaming}
              title={isStreaming ? '停止生成' : '发送'}
            >
              {isStreaming ? <Square className="w-4 h-4 fill-current" /> : <ArrowRight className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      <GlassConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="删除当前对话"
        description="删除后无法从历史记录中恢复，确认删除吗？"
        onConfirm={handleDeleteSession}
      />
    </div>
  );
}

function resolveSourceTables(
  sources: string[],
  selectedSmartTables: SmartTableSelection[]
): Array<{ name: string; table?: SmartTableSelection }> {
  return sources.map((name) => ({
    name,
    table: selectedSmartTables.find((table) => table.name === name || table.id === name),
  }));
}

function UserMessageBubble({
  message,
  expanded,
  onToggle,
}: {
  message: Message;
  expanded: boolean;
  onToggle: () => void;
}) {
  const shouldCollapse = message.content.length > 120 || message.content.split(/\n/).length > 4;

  return (
    <div className="voc-user-bubble w-fit max-w-[890px] min-w-0 break-words">
      <div className={shouldCollapse && !expanded ? 'line-clamp-4' : ''}>
        {message.content}
      </div>
      {shouldCollapse && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-3 inline-flex items-center gap-1 rounded-full bg-white/12 px-2.5 py-1 text-xs font-bold text-white/82 transition hover:bg-white/18 hover:text-white"
        >
          {expanded ? (
            <>
              收起
              <ChevronUp className="h-3.5 w-3.5" />
            </>
          ) : (
            <>
              展开全部
              <ChevronDown className="h-3.5 w-3.5" />
            </>
          )}
        </button>
      )}
    </div>
  );
}
