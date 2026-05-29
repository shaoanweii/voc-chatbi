'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Settings, BookOpen, RefreshCw } from 'lucide-react';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { ProfileDialog, type UserProfile } from '@/components/profile-dialog';
import { useAuthProfile, apiProfileToUserProfile } from '@/components/auth-provider';
import { usePinyinInitial } from '@/hooks/use-pinyin-initial';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip, AreaChart, Area, PieChart, Pie, Cell,
} from 'recharts';

// ============ 类型 ============

interface ReportOverview {
  totalUsers: number;
  totalSessions: number;
  totalRequests: number;
  totalSuccess: number;
  totalFailure: number;
  totalToken: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  crashRate: number;
}

interface IntentItem {
  intent: string;
  sessionCount: number;
  requestCount: number;
  tokenSum: number;
}

interface TrendItem {
  day: string;
  tokenSum: number;
  requestCount: number;
}

interface DailyStatusItem {
  day: string;
  successCount: number;
  failureCount: number;
}

interface UserRankItem {
  accountName: string;
  accountId: string;
  avatarUrl: string;
  requestCount: number;
  totalToken: number;
}

interface ErrorDetailItem {
  content: string;
  errorMessage: string;
  intent: string;
  accountName: string;
  createdAt: string;
}

interface ReportData {
  overview: ReportOverview;
  intents: IntentItem[];
  trends: TrendItem[];
  dailyStatus: DailyStatusItem[];
  userRanks: UserRankItem[];
  errorDetails: ErrorDetailItem[];
  range: string;
}

// ============ 刷新间隔（毫秒）============
const AUTO_REFRESH_INTERVAL_MS = 3_600_000; // 1 小时

// ============ 工具函数 ============

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  if (n >= 1_000) return n.toLocaleString('zh-CN');
  return String(n);
}

function formatToken(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function getIntentLabel(intent: string): string {
  const map: Record<string, string> = {
    simple_query: '普通问答', chart: 'Chart', report: 'Report',
    clarify: '澄清追问', error: '异常错误', unknown: '未知',
  };
  return map[intent] || intent;
}

function getAvatarColor(index: number): string {
  const colors = ['#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#f59e0b', '#06b6d4', '#ef4444', '#84cc16', '#f97316', '#6366f1'];
  return colors[index % colors.length];
}

function getAvatarLetter(name: string): string {
  return (name || '?').charAt(0).toUpperCase();
}

const DONUT_COLORS = ['#10b981', '#ef4444'];

// ============ 主组件 ============

export default function VocDataReportPage() {
  const router = useRouter();
  const { profile: userProfile } = useAuthProfile();
  const profileInitial = usePinyinInitial(userProfile?.accountName || '');
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [viewingUser, setViewingUser] = useState<UserProfile | null>(null);
  const [isViewProfileOpen, setIsViewProfileOpen] = useState(false);
  const [timeRange, setTimeRange] = useState<'today' | '7d' | '30d'>('7d');
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const USER_CACHE_PREFIX = 'voc:user-cache:';

  const fetchReport = useCallback(async (range: string, bypassCache = false, showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const url = `/api/audit/report?range=${range}${bypassCache ? '&force=1' : ''}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.success) {
        setData(json.data);
        // 前端缓存，下次打开页面直接展示
        try { sessionStorage.setItem('voc:report-cache:v1', JSON.stringify(json.data)); } catch {}
      } else {
        setData(null);
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 优先从 sessionStorage 恢复上次数据，避免闪烁
    try {
      const raw = sessionStorage.getItem('voc:report-cache:v1');
      if (raw) {
        const cached = JSON.parse(raw) as ReportData;
        if (cached.range === timeRange) {
          setData(cached);
          setLoading(false);
          // 静默刷新
          fetchReport(timeRange, false, false);
          return;
        }
      }
    } catch {}
    fetchReport(timeRange);
  }, [timeRange, fetchReport]);

  useEffect(() => {
    refreshTimerRef.current = setInterval(() => {
      fetchReport(timeRange, true);
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [fetchReport, timeRange]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await fetchReport(timeRange, true);
    setIsRefreshing(false);
  }, [fetchReport, timeRange]);

  const fetchUserProfile = useCallback(async (accountId: string): Promise<UserProfile | null> => {
    const cacheKey = `${USER_CACHE_PREFIX}${accountId}`;
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) return JSON.parse(raw) as UserProfile;
    } catch {
      // sessionStorage unavailable
    }

    try {
      const res = await fetch(`/api/users/by-account?accountId=${encodeURIComponent(accountId)}`);
      const json = await res.json();
      if (json.success && json.data) {
        const profile = apiProfileToUserProfile(json.data);
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify(profile));
        } catch {
          // sessionStorage full or unavailable, continue without caching
        }
        return profile;
      }
    } catch {
      // network error, fall through
    }

    try {
      sessionStorage.setItem(cacheKey, JSON.stringify(null));
    } catch {
      // ignore
    }
    return null;
  }, [USER_CACHE_PREFIX]);

  const handleViewUserProfile = useCallback(async (item: UserRankItem) => {
    const cacheKey = `${USER_CACHE_PREFIX}${item.accountId}`;
    let cachedProfile: UserProfile | null = null;
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed) cachedProfile = parsed as UserProfile;
      }
    } catch {
      // ignore
    }

    if (cachedProfile) {
      setViewingUser(cachedProfile);
      setIsViewProfileOpen(true);
      return;
    }

    setViewingUser({
      id: item.accountId,
      avatar: item.avatarUrl || '',
      accountName: item.accountName,
      account: item.accountId,
      email: '',
      phone: '',
      company: '',
      companyRole: '',
      bio: '',
    });
    setIsViewProfileOpen(true);

    const fullProfile = await fetchUserProfile(item.accountId);
    if (fullProfile) {
      setViewingUser(fullProfile);
    }
  }, [fetchUserProfile, USER_CACHE_PREFIX]);

  const overview = data?.overview;
  const intents = data?.intents || [];
  const trends = data?.trends || [];
  const dailyStatus = data?.dailyStatus || [];
  const userRanks = data?.userRanks || [];
  const errorDetails = data?.errorDetails || [];

  const orderedIntents = ['simple_query', 'chart', 'report'];
  const intentMap = new Map(intents.map((i) => [i.intent, i]));
  const topIntents = orderedIntents.map((key) => intentMap.get(key) || { intent: key, sessionCount: 0, requestCount: 0, tokenSum: 0 });

  const dateRangeLabel = () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ymd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    switch (timeRange) {
      case 'today': return ymd;
      case '7d': {
        const start = new Date(now.getTime() - 6 * 86400000);
        return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ~ ${ymd}`;
      }
      case '30d': {
        const start = new Date(now.getTime() - 29 * 86400000);
        return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ~ ${ymd}`;
      }
    }
  };

  const donutData = [
    { name: '成功', value: overview?.totalSuccess || 0 },
    { name: '失败', value: overview?.totalFailure || 0 },
  ];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="voc-page-bg min-h-screen relative overflow-hidden">
        <div className="voc-aura voc-aura-mint" style={{ left: '5%', top: '8%', width: 420, height: 420, opacity: 0.54 }} />
        <div className="voc-aura voc-aura-lavender" style={{ right: '8%', top: '5%', width: 380, height: 380, opacity: 0.48 }} />
        <div className="voc-aura voc-aura-blue" style={{ left: '30%', bottom: '10%', width: 500, height: 500, opacity: 0.42 }} />

        {/* 返回箭头 - 与 data-prep 一致，独立固定定位 */}
        <div className="fixed left-4 top-4 z-50">
          <button onClick={() => router.push('/data-prep')} className="w-10 h-10 rounded-full bg-white/70 flex items-center justify-center text-slate-500 backdrop-blur-sm hover:bg-white/90 transition-all shadow-sm">
            <ArrowLeft className="w-5 h-5" />
          </button>
        </div>

        {/* 顶部导航 — 与 data-prep 完全一致 */}
        <header className="sticky top-4 z-20 mx-auto max-w-[1320px] min-w-[1100px] px-10">
          <div className="rounded-3xl px-5 py-3.5 flex items-center justify-between bg-transparent">
            <div className="flex items-center gap-1">
              <img src="/assets/futonglogo.png" alt="富通科技" className="h-8 w-auto object-contain" />
            </div>
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
                    {userProfile ? (
                      userProfile.avatar ? (
                        <img
                          src={userProfile.avatar}
                          alt="用户头像"
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                            const parent = target.parentElement;
                            if (parent) {
                              const span = document.createElement('span');
                              span.className = 'flex h-full w-full items-center justify-center bg-gradient-to-br from-[#1f6bff] via-[#65c8df] to-[#35d07f] text-base font-extrabold text-white';
                              span.textContent = profileInitial;
                              parent.appendChild(span);
                            }
                          }}
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#1f6bff] via-[#65c8df] to-[#35d07f] text-base font-extrabold text-white">
                          {profileInitial}
                        </span>
                      )
                    ) : (
                      <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-200 to-slate-300 text-base font-extrabold text-slate-400">
                        ?
                      </span>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">个人中心</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </header>

        {/* 日期筛选 — logo 下方居中，类似 data-prep 的 tab 栏 */}
        <div className="sticky top-20 z-30 mx-auto flex justify-center pt-4 pb-2">
          <div className="inline-flex items-center gap-1 rounded-2xl border border-slate-200/70 bg-white/80 p-1.5 backdrop-blur-xl shadow-[0_4px_20px_rgba(15,23,42,0.06)]">
            {([
              { key: 'today' as const, label: '今天' },
              { key: '7d' as const, label: '近7天' },
              { key: '30d' as const, label: '近30天' },
            ]).map((item) => (
              <button
                key={item.key}
                onClick={() => setTimeRange(item.key)}
                className={`rounded-xl px-4 py-2 text-[13px] font-semibold transition-all ${
                  timeRange === item.key
                    ? 'bg-[linear-gradient(135deg,#6366f1_0%,#8b5cf6_100%)] text-white shadow-[0_2px_10px_rgba(99,102,241,0.30)]'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100/80'
                }`}
              >
                {item.label}
              </button>
            ))}
            <div className="w-px h-4 bg-slate-200 mx-1" />
            <span className="flex items-center gap-1.5 px-3 text-[13px] text-[#6d5df6] font-medium">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              {dateRangeLabel()}
            </span>
            <div className="w-px h-4 bg-slate-200 mx-1" />
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className={`rounded-xl px-3 py-2 text-[13px] font-semibold transition-all flex items-center gap-1.5 ${
                isRefreshing
                  ? 'text-[#6366f1] cursor-wait'
                  : 'text-slate-500 hover:text-[#6366f1] hover:bg-slate-100/80'
              }`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              刷新
            </button>
          </div>
        </div>

        {/* 主体内容 */}
        <div className="relative z-10 mx-auto max-w-[1320px] min-w-[1100px] px-10 pb-16 pt-4">
          {/* 加载态 */}
          {loading && (
            <div className="flex items-center justify-center py-32">
              <div className="flex flex-col items-center gap-4">
                <div className="w-10 h-10 border-2 border-[#6366f1]/30 border-t-[#6366f1] rounded-full animate-spin" />
                <span className="text-sm text-slate-400">加载审计数据中...</span>
              </div>
            </div>
          )}

          {!loading && (
            <div className="flex flex-col gap-6">
              {/* ===== 全局概览 + Token 占比 ===== */}
              <div className="grid grid-cols-[3fr_2fr] gap-6">
                {/* 左侧：三指标合并卡片 */}
                <div className="rounded-2xl border border-slate-200/60 bg-white/60 backdrop-blur-xl p-6 shadow-[0_10px_40px_-10px_rgba(15,23,42,0.06)]">
                  <div className="grid grid-cols-3 divide-x divide-slate-100 h-full">
                    <div className="flex items-center gap-4 px-6">
                      <div className="w-11 h-11 rounded-xl bg-[#eff6ff] flex items-center justify-center text-[#2563eb] shrink-0">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                        </svg>
                      </div>
                      <div>
                        <div className="text-[13px] font-medium text-slate-500">平台总使用人数</div>
                        <div className="text-[28px] font-extrabold text-slate-950 mt-0.5">{formatNumber(overview?.totalUsers ?? 0)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 px-6">
                      <div className="w-11 h-11 rounded-xl bg-[#ecfdf5] flex items-center justify-center text-[#059669] shrink-0">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                      </div>
                      <div>
                        <div className="text-[13px] font-medium text-slate-500">总对话请求次数</div>
                        <div className="text-[28px] font-extrabold text-slate-950 mt-0.5">{formatNumber(overview?.totalRequests ?? 0)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 px-6">
                      <div className="w-11 h-11 rounded-xl bg-[#fdf2f8] flex items-center justify-center text-[#db2777] shrink-0">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />
                        </svg>
                      </div>
                      <div>
                        <div className="text-[13px] font-medium text-slate-500">总消耗 Token</div>
                        <div className="text-[28px] font-extrabold text-slate-950 mt-0.5">{formatToken(overview?.totalToken ?? 0)}</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 右侧：输入/输出 Token 占比环形图 */}
                <div className="rounded-2xl border border-slate-200/60 bg-white/60 backdrop-blur-xl p-6 shadow-[0_10px_40px_-10px_rgba(15,23,42,0.06)]">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-1.5 h-5 rounded-full bg-[#6366f1]" />
                    <span className="text-[14px] font-bold text-slate-800">输入/输出 Token 占比</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="w-[120px] h-[120px] shrink-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={[
                              { name: '输入', value: overview?.totalPromptTokens || 0 },
                              { name: '输出', value: overview?.totalCompletionTokens || 0 },
                            ]}
                            cx="50%" cy="50%" innerRadius={32} outerRadius={52} paddingAngle={4} dataKey="value" stroke="none"
                          >
                            <Cell fill="#6366f1" />
                            <Cell fill="#06b6d4" />
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex flex-col gap-2 text-[12px]">
                      <div className="flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#6366f1]" />
                        <span className="text-slate-500">输入</span>
                        <span className="font-semibold text-slate-800 ml-auto">{formatToken(overview?.totalPromptTokens ?? 0)}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#06b6d4]" />
                        <span className="text-slate-500">输出</span>
                        <span className="font-semibold text-slate-800 ml-auto">{formatToken(overview?.totalCompletionTokens ?? 0)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* ===== 意图维度 ===== */}
              <div className="grid grid-cols-3 gap-6">
                {topIntents.map((item, index) => {
                  const color = ['#3b82f6', '#06b6d4', '#8b5cf6'][index];
                  const labels = ['普通问答', '图表生成', '报告生成'];
                  return (
                    <div key={item.intent} className="rounded-2xl border border-slate-200/60 bg-white/60 backdrop-blur-xl p-6 shadow-[0_10px_40px_-10px_rgba(15,23,42,0.06)]">
                      <div className="flex items-center gap-2.5 mb-4">
                        <div className="w-1.5 h-5 rounded-full" style={{ background: color }} />
                        <span className="text-[14px] font-bold text-slate-800">{labels[index]}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="rounded-xl bg-slate-50/80 px-3 py-2.5">
                          <div className="text-[12px] text-slate-500">使用人数</div>
                          <div className="text-[17px] font-bold text-slate-800 mt-0.5">{formatNumber(item.sessionCount)}</div>
                        </div>
                        <div className="rounded-xl bg-slate-50/80 px-3 py-2.5">
                          <div className="text-[12px] text-slate-500">对话次数</div>
                          <div className="text-[17px] font-bold text-slate-800 mt-0.5">{formatNumber(item.requestCount)}</div>
                        </div>
                        <div className="rounded-xl bg-slate-50/80 px-3 py-2.5">
                          <div className="text-[12px] text-slate-500">消耗Token</div>
                          <div className="text-[17px] font-bold mt-0.5" style={{ color }}>{formatToken(item.tokenSum)}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ===== Token趋势 + 人员排行 ===== */}
              <div className="grid grid-cols-2 gap-6">
                <div className="rounded-2xl border border-slate-200/60 bg-white/60 backdrop-blur-xl p-6 shadow-[0_10px_40px_-10px_rgba(15,23,42,0.06)]">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-1.5 h-5 rounded-full bg-orange-400" />
                    <span className="text-[14px] font-bold text-slate-800">峰值 Token 消耗趋势</span>
                  </div>
                  <div className="h-[220px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={trends}>
                        <defs>
                          <linearGradient id="trendArea" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.25} />
                            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={(v: number) => v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)} width={40} />
                        <ReTooltip
                          contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, fontSize: 12, boxShadow: '0 10px 30px rgba(15,23,42,0.08)' }}
                          formatter={(value: number) => [formatToken(value), 'Token 消耗']}
                        />
                        <Area type="linear" dataKey="tokenSum" stroke="#3b82f6" strokeWidth={2} fill="url(#trendArea)" dot={{ r: 3, fill: '#3b82f6', stroke: '#fff', strokeWidth: 2 }} activeDot={{ r: 5, fill: '#3b82f6', stroke: '#fff', strokeWidth: 2 }} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200/60 bg-white/60 backdrop-blur-xl p-6 shadow-[0_10px_40px_-10px_rgba(15,23,42,0.06)]">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-1.5 h-5 rounded-full bg-violet-500" />
                    <span className="text-[14px] font-bold text-slate-800">人员使用排行榜</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="border-b border-slate-100">
                          <th className="text-left py-2.5 pl-1 text-[12px] font-semibold text-slate-500">账号</th>
                          <th className="text-right py-2.5 text-[12px] font-semibold text-slate-500">使用次数</th>
                          <th className="text-right py-2.5 pr-1 text-[12px] font-semibold text-slate-500">消耗Token</th>
                        </tr>
                      </thead>
                      <tbody>
                        {userRanks.map((item, i) => (
                          <tr key={i} className="border-b border-slate-50 last:border-none">
                            <td className="py-2.5 pl-1">
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => handleViewUserProfile(item)}
                                  className="cursor-pointer"
                                >
                                  {item.avatarUrl ? (
                                    <img src={item.avatarUrl} alt="" className="w-6 h-6 rounded-full object-cover shrink-0 hover:ring-2 hover:ring-[#6366f1]/40 transition-all" />
                                  ) : (
                                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 hover:ring-2 hover:ring-[#6366f1]/40 transition-all" style={{ background: getAvatarColor(i) }}>
                                      {getAvatarLetter(item.accountName)}
                                    </div>
                                  )}
                                </button>
                                <span className="text-[13px] text-slate-700 font-medium truncate max-w-[110px]">{item.accountName}</span>
                              </div>
                            </td>
                            <td className="py-2.5 text-[13px] text-slate-600 text-right">{formatNumber(item.requestCount)}</td>
                            <td className="py-2.5 pr-1 text-[13px] text-slate-700 font-semibold text-right">{formatToken(item.totalToken)}</td>
                          </tr>
                        ))}
                        {userRanks.length === 0 && (
                          <tr><td colSpan={3} className="py-10 text-center text-[13px] text-slate-400">暂无使用数据</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* ===== 成功/失败分析 ===== */}
              <div className="rounded-2xl border border-slate-200/60 bg-white/60 backdrop-blur-xl p-6 shadow-[0_10px_40px_-10px_rgba(15,23,42,0.06)]">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-1.5 h-5 rounded-full bg-red-500" />
                  <span className="text-[14px] font-bold text-slate-800">应用调用成功/失败崩溃率统计</span>
                </div>

                <div className="grid grid-cols-[0.6fr_1fr_1.4fr] gap-6 items-stretch">
                  {/* 左侧：环形图 */}
                  <div className="flex flex-col items-center pt-2">
                    <div className="relative w-[130px] h-[130px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={donutData} cx="50%" cy="50%" innerRadius={36} outerRadius={58} paddingAngle={4} dataKey="value" stroke="none">
                            {donutData.map((_, idx) => (
                              <Cell key={idx} fill={DONUT_COLORS[idx]} />
                            ))}
                          </Pie>
                          <ReTooltip
                            contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, fontSize: 12 }}
                            formatter={(value: number, name: string) => [formatNumber(value), name]}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className="text-center">
                          <div className="text-[15px] font-extrabold text-slate-800">{overview?.crashRate ?? 0}%</div>
                          <div className="text-[10px] text-slate-400 leading-tight">崩溃率</div>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-3 mt-2">
                      <span className="text-[12px] font-medium text-slate-600 flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-[#10b981]" /> 成功 {formatNumber(overview?.totalSuccess ?? 0)}
                      </span>
                      <span className="text-[12px] font-medium text-slate-600 flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-[#ef4444]" /> 失败 {formatNumber(overview?.totalFailure ?? 0)}
                      </span>
                    </div>
                  </div>

                  {/* 中间：每日成功/失败折线图 */}
                  <div className="h-[210px]">
                    <div className="text-[13px] font-bold text-slate-700 mb-2">趋势明细</div>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={dailyStatus}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} width={32} />
                        <ReTooltip
                          contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, fontSize: 12 }}
                          formatter={(value: number, name: string) => [formatNumber(value), name]}
                        />
                        <Line type="linear" dataKey="successCount" name="成功" stroke="#10b981" strokeWidth={2} dot={{ r: 2, fill: '#10b981' }} />
                        <Line type="linear" dataKey="failureCount" name="失败" stroke="#ef4444" strokeWidth={2} dot={{ r: 2, fill: '#ef4444' }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* 右侧：失败明细 */}
                  <div className="flex flex-col">
                    <div className="text-[13px] font-bold text-slate-700 mb-2">异常/崩溃明细</div>
                    <div className="flex flex-col gap-1.5 max-h-[210px] overflow-y-auto pr-1">
                      {errorDetails.map((err, i) => (
                        <div key={i} className="rounded-lg border border-slate-100 bg-white/70 px-3 py-2 text-[12px]">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 text-[11px] text-slate-700 font-semibold">
                              <span>{err.createdAt}</span>
                              <span>·</span>
                              <span>{getIntentLabel(err.intent)}</span>
                            </div>
                            <span className="bg-red-50 text-red-600 px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0">失败</span>
                          </div>
                          <div className="text-slate-900 font-medium mt-0.5 leading-snug">{err.errorMessage || err.content?.slice(0, 80) || '未知错误'}</div>
                        </div>
                      ))}
                      {errorDetails.length === 0 && (
                        <div className="py-8 text-center text-[13px] text-slate-400">暂无异常记录</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 版权信息 */}
          <footer className="mt-10 pb-8 text-center text-slate-400 text-[13px]">
            <div>版权所有 &copy; 富通科技 2026</div>
          </footer>
        </div>
      </div>

      <ProfileDialog
        open={isProfileOpen}
        onOpenChange={setIsProfileOpen}
      />
      <ProfileDialog
        open={isViewProfileOpen}
        onOpenChange={setIsViewProfileOpen}
        profile={viewingUser}
        readonly
      />
    </TooltipProvider>
  );
}
