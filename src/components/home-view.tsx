'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FOLLOW_UP_VARIANTS } from '@/lib/types';
import { Settings, BookOpen, Sparkles, ArrowRight, Brain } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { TablePickerDialog, type SmartTableSelection } from '@/components/table-picker-dialog';
import { ChatHistoryDialog, type LoadedChatHistory } from '@/components/chat-history-dialog';
import { ProfileDialog, type UserProfile } from '@/components/profile-dialog';
import { useAuthProfile } from '@/components/auth-provider';
import { usePinyinInitial } from '@/hooks/use-pinyin-initial';

interface HomeViewProps {
  selectedSmartTables: SmartTableSelection[];
  isReasoning: boolean;
  onSmartTablesChange: (tables: SmartTableSelection[]) => void;
  onHistorySelect: (history: LoadedChatHistory) => void;
  onReasoningToggle: () => void;
  onSend: (query: string) => void;
  onSuggestionClick: (query: string) => void;
}

export function HomeView({
  selectedSmartTables,
  isReasoning,
  onSmartTablesChange,
  onHistorySelect,
  onReasoningToggle,
  onSend,
  onSuggestionClick,
}: HomeViewProps) {
  const [query, setQuery] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const { profile: userProfile, updateProfileCache } = useAuthProfile();
  const profileInitial = usePinyinInitial(userProfile?.accountName || userProfile?.account);

  const router = useRouter();
  const selectedTableKey = useMemo(
    () => selectedSmartTables.map((table) => table.id).join(','),
    [selectedSmartTables]
  );

  useEffect(() => {
    if (selectedSmartTables.length === 0) {
      setSuggestedQuestions([]);
      setSuggestionsLoading(false);
      return;
    }

    let cancelled = false;
    setSuggestionsLoading(true);
    setSuggestedQuestions([]);

    fetch('/api/chat/suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        smartTableIds: selectedSmartTables.map((table) => table.id),
      }),
    })
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success && Array.isArray(json.data)) {
          setSuggestedQuestions(json.data.map((item: unknown) => String(item)).filter(Boolean).slice(0, 3));
        } else {
          setSuggestedQuestions([]);
        }
      })
      .catch(() => {
        if (!cancelled) setSuggestedQuestions([]);
      })
      .finally(() => {
        if (!cancelled) setSuggestionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSmartTables, selectedTableKey]);

  const handleSend = () => {
    if (query.trim()) {
      onSend(query.trim());
      setQuery('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="voc-page-bg min-h-screen relative overflow-hidden">
      {/* Aura decorations */}
      <div className="voc-aura voc-aura-mint" style={{ left: '5%', top: '8%', width: 320, height: 320, opacity: 0.54 }} />
      <div className="voc-aura voc-aura-lavender" style={{ right: '8%', top: '5%', width: 280, height: 280, opacity: 0.48 }} />
      <div className="voc-aura voc-aura-blue" style={{ left: '30%', bottom: '10%', width: 420, height: 200, opacity: 0.6 }} />

      {/* Top bar - no border */}
      <header className="sticky top-4 z-20 mx-auto max-w-[1320px] min-w-[1100px] px-10">
        <div className="rounded-3xl px-5 py-3.5 flex items-center justify-between bg-transparent">
          <div className="flex flex-col gap-1">
            <img src="/assets/futonglogo.png" alt="富通科技" className="h-8 w-auto object-contain" />
            {/* <strong className="text-[17px] tracking-tight text-slate-950">VOC 智能问数</strong> */}
          </div>
          <div className="flex items-center gap-1 ml-auto pl-8">
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
        </div>
      </header>

      {/* 个人资料弹窗 */}
      <ProfileDialog
        open={isProfileOpen}
        onOpenChange={setIsProfileOpen}
        profile={userProfile}
        onProfileChange={updateProfileCache}
      />

      {/* Center content */}
      <main className="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] px-4">
        <div className="voc-animate-in flex flex-col items-center w-full max-w-[800px]">
          {/* Title */}
          <h1 className="text-[34px] leading-[1.45] font-extrabold text-center tracking-tight text-slate-950 mb-2">
            用自然语言，<span className="bg-[linear-gradient(135deg,#1f6bff_0%,#65c8df_58%,#35d07f_100%)] bg-clip-text text-transparent">直接得到业务答案</span>
          </h1>
          <p className="text-base text-slate-500 text-center mb-10">
            你身边的汽车数据分析专家，连接数据库或上传表格，自动生成 SQL、图表与专业分析结论
          </p>

          {/* Data source chips - 动态查询已启用的数据源 */}
          <div className="flex items-center gap-3 mb-6 flex-wrap">
            <ChatHistoryDialog onSelectConversation={onHistorySelect} />
            <TablePickerDialog
              triggerClassName="voc-chip"
              selectedTables={selectedSmartTables}
              onSelectedTablesChange={onSmartTablesChange}
            />
          </div>

          {/* Search card - glass */}
          <div
            className={`voc-glass-strong rounded-[24px] w-full h-[118px] relative flex items-center px-7 transition-all duration-300 ${
              isReasoning ? 'voc-reasoning-glow' : ''
            } ${isFocused && !isReasoning ? 'ring-2 ring-purple-400/40' : ''}`}
          >
            <div className="mr-2.5 flex h-full w-[10px] flex-shrink-0 items-center justify-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-[16px] bg-white/76 text-purple-600 shadow-[0_12px_30px_rgba(109,93,246,0.14)]">
                <Sparkles className="w-4 h-4" />
              </div>
            </div>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="请输入您的问题..."
              className="min-w-0 flex-1 bg-transparent outline-none text-base text-slate-600 placeholder:text-slate-400"
            />
            <div className="ml-2.5 flex h-full w-[70px] shrink-0 items-center justify-center">
              <button
                className={`voc-send-btn !h-9 !w-11 ${!query.trim() ? 'opacity-50 cursor-not-allowed' : ''}`}
                onClick={handleSend}
                disabled={!query.trim()}
              >
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
            <button
              className={`absolute bottom-2 left-1/2 flex h-6 -translate-x-1/2 items-center gap-1 rounded-full border px-2.5 text-[11px] font-semibold transition-all duration-200 ${
                isReasoning
                  ? 'border-purple-300/60 bg-purple-50/80 text-purple-600'
                  : 'border-gray-200/80 bg-white/58 text-slate-400 hover:text-slate-600 hover:bg-white/80'
              }`}
              onClick={onReasoningToggle}
              title={isReasoning ? '关闭推理模式' : '开启推理模式'}
            >
              <Brain className={`w-3 h-3 ${isReasoning ? 'voc-heartbeat' : ''}`} />
              {isReasoning ? '深度推理' : '快速模式'}
            </button>
          </div>

          {selectedSmartTables.length > 0 && suggestionsLoading && (
            <div className="flex gap-5 mt-8">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="h-10 w-[150px] rounded-full border border-white/70 bg-white/45 shadow-sm backdrop-blur-xl"
                />
              ))}
            </div>
          )}

          {selectedSmartTables.length > 0 && !suggestionsLoading && suggestedQuestions.length > 0 && (
            <div className="flex gap-5 mt-8">
              {suggestedQuestions.map((label, index) => (
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
        </div>
      </main>

      {/* Privacy notice */}


      <footer className="absolute bottom-8 left-1/2 -translate-x-1/2 text-slate-400 text-[13px] text-center space-y-1">
        <div>版权所有 © 富通科技 2026</div>
        <div>问答记录仅保留最近 30 天，数据不会用于训练模型</div>
      </footer>
    </div>
  );
}
