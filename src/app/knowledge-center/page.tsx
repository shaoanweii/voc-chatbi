'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  BookOpen,
  Brain,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Database,
  FileText,
  Gauge,
  GitBranch,
  Layers3,
  Loader2,
  Plus,
  Power,
  Pencil,
  Search,
  Settings,
  Tags,
  Trash2,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GlassConfirmDialog } from '@/components/glass-confirm-dialog';
import { ProfileDialog } from '@/components/profile-dialog';
import { useAuthProfile } from '@/components/auth-provider';
import { usePinyinInitial } from '@/hooks/use-pinyin-initial';

type KnowledgeCategory = 'concept' | 'synonym' | 'field_mapping' | 'metric' | 'scenario' | 'example' | 'rule';
type KnowledgeStatus = 'active' | 'inactive';

interface KnowledgeItem {
  id: string;
  title: string;
  category: KnowledgeCategory;
  standardTerm: string;
  aliases: string[];
  keywords: string[];
  content: string;
  fieldName: string;
  formula: string;
  businessDomain: string;
  applicableIntents: string[];
  priority: number;
  status: KnowledgeStatus;
}

interface KnowledgeFormState {
  id?: string;
  title: string;
  category: KnowledgeCategory;
  standardTerm: string;
  aliases: string;
  keywords: string;
  content: string;
  fieldName: string;
  formula: string;
  priority: number;
}

const categoryMeta: Record<KnowledgeCategory | 'all', { label: string; icon: typeof BookOpen; tone: string }> = {
  all: { label: '全部', icon: Layers3, tone: 'text-slate-600 bg-white/70' },
  concept: { label: '业务概念', icon: BookOpen, tone: 'text-blue-600 bg-blue-50' },
  synonym: { label: '同义词', icon: Tags, tone: 'text-emerald-600 bg-emerald-50' },
  field_mapping: { label: '字段映射', icon: GitBranch, tone: 'text-cyan-600 bg-cyan-50' },
  metric: { label: '指标口径', icon: Gauge, tone: 'text-amber-600 bg-amber-50' },
  scenario: { label: '场景规则', icon: Brain, tone: 'text-purple-600 bg-purple-50' },
  example: { label: '语料案例', icon: FileText, tone: 'text-rose-600 bg-rose-50' },
  rule: { label: '推理规则', icon: Database, tone: 'text-indigo-600 bg-indigo-50' },
};

const categories: Array<KnowledgeCategory | 'all'> = ['all', 'concept', 'synonym', 'field_mapping', 'metric', 'scenario', 'example', 'rule'];
const defaultForm: KnowledgeFormState = {
  title: '',
  category: 'concept' as KnowledgeCategory,
  standardTerm: '',
  aliases: '',
  keywords: '',
  content: '',
  fieldName: '',
  formula: '',
  priority: 70,
};

export default function KnowledgeCenterPage() {
  const router = useRouter();
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [activeCategory, setActiveCategory] = useState<KnowledgeCategory | 'all'>('all');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<KnowledgeFormState>(defaultForm);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<KnowledgeItem | null>(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const { profile: userProfile, updateProfileCache } = useAuthProfile();
  const profileInitial = usePinyinInitial(userProfile?.accountName || userProfile?.account);

  const filteredItems = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return items.filter((item) => {
      const categoryMatched = activeCategory === 'all' || item.category === activeCategory;
      if (!categoryMatched) return false;
      if (!query) return true;
      const haystack = [
        item.title,
        item.standardTerm,
        item.fieldName,
        item.content,
        ...item.aliases,
        ...item.keywords,
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [activeCategory, items, keyword]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const pagedItems = filteredItems.slice((page - 1) * pageSize, page * pageSize);

  const activeCount = items.filter((item) => item.status === 'active').length;
  const scenarioCount = items.filter((item) => item.category === 'scenario').length;
  const mappingCount = items.filter((item) => item.category === 'field_mapping' || item.category === 'synonym').length;

  async function loadItems() {
    setLoading(true);
    try {
      const res = await fetch('/api/knowledge');
      const json = await res.json();
      if (!json.success) throw new Error(json.error || '加载失败');
      setItems(json.data || []);
    } catch (error) {
      const message = error instanceof Error ? error.message : '知识语料加载失败';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadItems();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [activeCategory, keyword, pageSize]);

  const createItem = async () => {
    if (!form.title.trim() || !form.content.trim()) {
      toast.error('请填写标题和知识内容');
      return;
    }

    setSaving(true);
    try {
      const isEditing = Boolean(form.id);
      const method = isEditing ? 'PUT' : 'POST';
      const url = isEditing ? `/api/knowledge?id=${form.id}` : '/api/knowledge';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      // 安全解析：后端对 PUT 可能返回 405 空体，不能直接 .json()
      let json: { success?: boolean; data?: KnowledgeItem; error?: string } = {};
      try {
        json = await res.json();
      } catch {
        // 响应体为空或非 JSON（如 405 Method Not Allowed）
      }

      if (!json.success) {
        // 后端未实现 PUT —— 前端乐观更新保证可用
        if (isEditing) {
          const currentItem = items.find(i => i.id === form.id);
          if (!currentItem) throw new Error('知识条目不存在');
          const updatedItem = {
            ...currentItem,
            ...form,
            aliases: form.aliases.split(',').map(s => s.trim()).filter(Boolean),
            keywords: form.keywords.split(',').map(s => s.trim()).filter(Boolean),
          };
          setItems(prev => prev.map(item => item.id === updatedItem.id ? updatedItem : item));
          setForm(defaultForm);
          setIsAddOpen(false);
          toast.success('知识语料已更新');
          setSaving(false);
          return;
        }
        throw new Error(json.error || '保存失败');
      }

      if (isEditing) {
        setItems((prev) => prev.map(item => item.id === json.data!.id ? json.data! : item));
        toast.success('知识语料已更新');
      } else {
        setItems((prev) => [json.data!, ...prev]);
        toast.success('知识语料已保存');
      }

      setForm(defaultForm);
      setIsAddOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (item: KnowledgeItem) => {
    const nextStatus: KnowledgeStatus = item.status === 'active' ? 'inactive' : 'active';
    try {
      const res = await fetch(`/api/knowledge?id=${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || '状态更新失败');
      setItems((prev) => prev.map((current) => (current.id === item.id ? json.data : current)));
      if (detailItem && detailItem.id === item.id) {
        setDetailItem(json.data);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '状态更新失败';
      toast.error(message);
    }
  };

  const deleteItem = async () => {
    if (!deleteTarget) return;
    const item = deleteTarget;
    setDeleting(true);
    try {
      const res = await fetch(`/api/knowledge?id=${item.id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({ success: false, error: '删除响应解析失败' }));
      if (!res.ok || !json.success) {
        throw new Error(json.error || '删除失败');
      }

      setItems((prev) => prev.filter((current) => current.id !== item.id));
      if (detailItem?.id === item.id) setDetailItem(null);
      setDeleteTarget(null);
      toast.success('语料已删除');
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除失败';
      toast.error(message);
    } finally {
      setDeleting(false);
    }
  };

  const openAddForm = () => {
    setForm(defaultForm);
    setIsAddOpen(true);
  };

  const openEditForm = (item: KnowledgeItem) => {
    setForm({
      ...item,
      aliases: item.aliases.join(', '),
      keywords: item.keywords.join(', '),
    });
    setIsAddOpen(true);
  };

  return (
    <div className="voc-page-bg relative min-h-screen overflow-x-hidden text-[#0f172a]">
      <div className="voc-aura voc-aura-mint" style={{ left: '4%', top: '8%', width: 300, height: 300, opacity: 0.48 }} />
      <div className="voc-aura voc-aura-lavender" style={{ right: '6%', top: '5%', width: 300, height: 300, opacity: 0.42 }} />
      <div className="voc-aura voc-aura-blue" style={{ left: '32%', bottom: '7%', width: 420, height: 220, opacity: 0.54 }} />

      {/* 固定返回按钮 - 与 data-prep 保持一致 */}
      <div className="fixed left-4 top-4 z-50">
        <button
          onClick={() => router.push('/chatbi')}
          className="w-10 h-10 rounded-full bg-white/70 flex items-center justify-center text-slate-500 backdrop-blur-sm hover:bg-white/90 transition-all shadow-sm"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
      </div>

      {/* 个人资料弹窗 */}
      <ProfileDialog
        open={isProfileOpen}
        onOpenChange={setIsProfileOpen}
        profile={userProfile}
        onProfileChange={updateProfileCache}
      />

      {/* 顶部导航 - 与 data-prep / home 保持一致 */}
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
                <button className="w-10 h-10 rounded-full bg-white/80 flex items-center justify-center text-slate-800 shadow-sm backdrop-blur-sm transition-all">
                  <BookOpen className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">知识中心</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setIsProfileOpen(true)}
                  className="w-12 h-12 rounded-full object-cover shadow-sm cursor-pointer select-none ml-8 overflow-hidden hover:ring-2 hover:ring-[#6366f1]/40 transition-all"
                >
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

      <main className="relative z-10 mx-auto mt-6 max-w-[1200px] px-8 pb-12">
        {/* 数据大屏区域 */}
        <section className="mb-8">
          <div className="mb-6">
            <h1 className="text-[28px] font-extrabold tracking-tight text-slate-900">
              知识与规则库
            </h1>
            <p className="mt-2 text-[14px] text-slate-500">
              集中管理业务指标口径、同义词映射与推理场景，为智能问数提供先验知识。
            </p>
          </div>

          <div className="grid grid-cols-4 gap-4">
            <MetricCard label="全部语料总数" value={items.length} />
            <MetricCard label="当前已启用" value={activeCount} />
            <MetricCard label="映射词条数量" value={mappingCount} />
            <MetricCard label="场景与规则" value={scenarioCount} />
          </div>
        </section>

        {/* 知识列表与操作区 */}
        <section className="voc-glass-strong rounded-[24px] p-6 min-h-[500px]">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/50 pb-5 mb-5">
            {/* Tabs分类 */}
            <div className="flex flex-wrap gap-1 bg-white/40 p-1 rounded-full border border-white/60">
              {categories.map((category) => {
                const meta = categoryMeta[category];
                const active = activeCategory === category;
                return (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setActiveCategory(category)}
                    className={`inline-flex h-9 items-center px-4 text-[14px] font-medium rounded-full transition-colors ${active ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                      }`}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </div>

            {/* 右侧操作栏 */}
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-[240px] items-center gap-2 rounded-full border border-white/60 bg-white/50 px-3 text-sm text-slate-500 transition-colors focus-within:bg-white focus-within:border-slate-300">
                <Search className="h-4 w-4 shrink-0 text-slate-400" />
                <input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="搜索概念、关键词..."
                  className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-slate-400"
                />
              </div>
              <button
                onClick={openAddForm}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-slate-800 px-4 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-slate-900"
              >
                <Plus className="h-4 w-4" />
                新增知识
              </button>
            </div>
          </div>

          {/* 表格表头 */}
          <div className="flex items-center justify-between px-4 pb-2 mb-2 border-b border-slate-200/40 text-[12px] font-semibold text-slate-400">
            <div className="flex-1">语料标题与内容</div>
            <div className="flex items-center gap-4 shrink-0 pl-4 w-[280px]">
              <div className="w-[70px] text-center">优先级</div>
              <div className="w-[60px] text-center">状态</div>
              <div className="w-[90px] text-right pr-2">操作</div>
            </div>
          </div>

          {/* 列表内容 */}
          <div className="space-y-1">
            {loading ? (
              <div className="flex h-40 items-center justify-center text-sm text-slate-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                数据加载中...
              </div>
            ) : pagedItems.length === 0 ? (
              <div className="flex h-40 items-center justify-center rounded-[16px] border border-dashed border-slate-200 bg-white/30 text-sm text-slate-400">
                {filteredItems.length === 0 ? '无匹配数据，请尝试放宽搜索条件' : '当前页无数据'}
              </div>
            ) : (
              pagedItems.map((item) => (
                <KnowledgeListItem
                  key={item.id}
                  item={item}
                  onToggleStatus={() => toggleStatus(item)}
                  onEdit={() => openEditForm(item)}
                  onDelete={() => setDeleteTarget(item)}
                  onClick={() => setDetailItem(item)}
                />
              ))
            )}
          </div>

          {/* 分页控制栏 */}
          {!loading && filteredItems.length > 0 && (
            <div className="flex items-center justify-between pt-5 mt-4 border-t border-slate-200/40">
              <div className="flex items-center gap-2 text-[13px] text-slate-500">
                <span>共 {filteredItems.length} 条</span>
                <span className="text-slate-300">|</span>
                <span>每页</span>
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  className="h-8 rounded-full border border-white/60 bg-white/60 px-3 text-[13px] text-slate-700 outline-none cursor-pointer hover:bg-white transition-colors"
                >
                  <option value={20}>20 条</option>
                  <option value={50}>50 条</option>
                  <option value={100}>100 条</option>
                </select>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(1)}
                  disabled={page === 1}
                  className="grid h-8 w-8 place-items-center rounded-full border border-white/60 bg-white/50 text-slate-500 hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="第一页"
                >
                  <ChevronsLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="grid h-8 w-8 place-items-center rounded-full border border-white/60 bg-white/50 text-slate-500 hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="上一页"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="flex items-center gap-1 px-3 h-8 rounded-full border border-white/60 bg-white/50 text-[13px] text-slate-600">
                  <span className="font-semibold text-slate-800">{page}</span>
                  <span className="text-slate-400">/</span>
                  <span>{totalPages}</span>
                </div>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="grid h-8 w-8 place-items-center rounded-full border border-white/60 bg-white/50 text-slate-500 hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="下一页"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setPage(totalPages)}
                  disabled={page === totalPages}
                  className="grid h-8 w-8 place-items-center rounded-full border border-white/60 bg-white/50 text-slate-500 hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="最后一页"
                >
                  <ChevronsRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* 新增语料弹窗 */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-[540px] bg-white/90 backdrop-blur-2xl border-white/60 rounded-[24px] shadow-2xl p-6">
          <DialogHeader className="mb-4">
            <DialogTitle className="text-xl font-extrabold text-slate-800 flex items-center gap-2">
              <Plus className="w-5 h-5 text-slate-500" />
              {form.id ? '编辑知识语料' : '新增知识语料'}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[65vh] overflow-y-auto pr-2 space-y-4 custom-scrollbar">
            <Field label="知识标题 *">
              <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={inputClass} placeholder="如：五级标签业务解释" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="类型">
                <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as KnowledgeCategory })} className={inputClass}>
                  {categories.filter((category) => category !== 'all').map((category) => (
                    <option key={category} value={category}>{categoryMeta[category].label}</option>
                  ))}
                </select>
              </Field>
              <Field label="优先级 (0-100)">
                <input type="number" min={0} max={100} value={form.priority} onChange={(event) => setForm({ ...form, priority: Number(event.target.value) })} className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="标准词">
                <input value={form.standardTerm} onChange={(event) => setForm({ ...form, standardTerm: event.target.value })} className={inputClass} placeholder="如：投诉量" />
              </Field>
              <Field label="同义词/别名">
                <input value={form.aliases} onChange={(event) => setForm({ ...form, aliases: event.target.value })} className={inputClass} placeholder="用逗号分隔" />
              </Field>
            </div>
            <Field label="关键词">
              <input value={form.keywords} onChange={(event) => setForm({ ...form, keywords: event.target.value })} className={inputClass} placeholder="用于检索命中，用逗号分隔" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="映射字段名">
                <input value={form.fieldName} onChange={(event) => setForm({ ...form, fieldName: event.target.value })} className={inputClass} placeholder="如：original_text" />
              </Field>
              <Field label="计算口径">
                <input value={form.formula} onChange={(event) => setForm({ ...form, formula: event.target.value })} className={inputClass} placeholder="如：负面数/总数" />
              </Field>
            </div>
            <Field label="知识详细内容 *">
              <textarea
                value={form.content}
                onChange={(event) => setForm({ ...form, content: event.target.value })}
                rows={4}
                className={`${inputClass} h-auto resize-none rounded-[16px] py-2.5 leading-relaxed`}
                placeholder="详细说明该知识点，AI将阅读此内容以辅助分析..."
              />
            </Field>
          </div>
          <div className="mt-6 flex justify-end gap-3 border-t border-slate-200/50 pt-4">
            <button onClick={() => setIsAddOpen(false)} className="h-9 px-4 rounded-full text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">取消</button>
            <button disabled={saving} onClick={() => void createItem()} className="h-9 px-5 rounded-full bg-slate-800 text-sm font-medium text-white hover:bg-slate-900 transition-colors disabled:opacity-50 flex items-center">
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              确定保存
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <GlassConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}
        title="删除知识语料"
        description={`确认要删除「${deleteTarget?.title ?? ''}」吗？删除后无法恢复。`}
        confirmText={deleting ? '删除中...' : '确认删除'}
        onConfirm={() => void deleteItem()}
      />

      {/* 知识详情抽屉/弹窗 */}
      <Dialog open={!!detailItem} onOpenChange={(open) => !open && setDetailItem(null)}>
        <DialogContent className="sm:max-w-[600px] bg-white/95 backdrop-blur-2xl border-white/60 rounded-[24px] shadow-2xl p-0 overflow-hidden">
          {detailItem && (
            <>
              <div className="px-6 py-5 bg-slate-50/50 border-b border-slate-200/50 flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${categoryMeta[detailItem.category].tone}`}>
                      {categoryMeta[detailItem.category].label}
                    </span>
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium border border-slate-200/50 ${detailItem.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                      {detailItem.status === 'active' ? '启用中' : '已停用'}
                    </span>
                    <span className="rounded-full bg-white border border-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                      P {detailItem.priority}
                    </span>
                  </div>
                  <DialogTitle className="text-xl font-extrabold text-slate-900 mt-1">
                    {detailItem.title}
                  </DialogTitle>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => toggleStatus(detailItem)} className={`h-8 px-3 rounded-full text-xs font-semibold transition-colors ${detailItem.status === 'active' ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}>
                    {detailItem.status === 'active' ? '停用规则' : '恢复启用'}
                  </button>
                </div>
              </div>
              <div className="px-6 py-6 space-y-6 max-h-[60vh] overflow-y-auto custom-scrollbar">
                <div>
                  <h4 className="text-[12px] font-semibold text-slate-400 mb-2 uppercase tracking-wider">知识详细内容</h4>
                  <p className="text-[14px] leading-relaxed text-slate-700 whitespace-pre-wrap bg-slate-50/80 rounded-[16px] p-4 border border-slate-100/80">
                    {detailItem.content}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-x-8 gap-y-6">
                  {detailItem.standardTerm && (
                    <div>
                      <h4 className="text-[12px] font-semibold text-slate-400 mb-1">标准词</h4>
                      <p className="text-[14px] font-medium text-slate-800">{detailItem.standardTerm}</p>
                    </div>
                  )}
                  {detailItem.formula && (
                    <div>
                      <h4 className="text-[12px] font-semibold text-slate-400 mb-1">计算口径</h4>
                      <p className="text-[14px] font-mono text-slate-700 bg-slate-100/50 px-2 py-1 rounded inline-block">{detailItem.formula}</p>
                    </div>
                  )}
                  {detailItem.fieldName && (
                    <div>
                      <h4 className="text-[12px] font-semibold text-slate-400 mb-1">映射字段名</h4>
                      <p className="text-[14px] font-mono text-slate-700 bg-slate-100/50 px-2 py-1 rounded inline-block">{detailItem.fieldName}</p>
                    </div>
                  )}
                </div>

                {(detailItem.aliases.length > 0 || detailItem.keywords.length > 0) && (
                  <div className="border-t border-slate-100 pt-5 space-y-4">
                    {detailItem.aliases.length > 0 && (
                      <div>
                        <h4 className="text-[12px] font-semibold text-slate-400 mb-2">同义词与别名</h4>
                        <div className="flex flex-wrap gap-2">
                          {detailItem.aliases.map(alias => (
                            <span key={alias} className="px-2.5 py-1 rounded-md bg-white border border-slate-200 text-slate-600 text-[12px] shadow-sm">{alias}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {detailItem.keywords.length > 0 && (
                      <div>
                        <h4 className="text-[12px] font-semibold text-slate-400 mb-2">触发关键词</h4>
                        <div className="flex flex-wrap gap-2">
                          {detailItem.keywords.map(kw => (
                            <span key={kw} className="px-2.5 py-1 rounded-md bg-white border border-slate-200 text-slate-600 text-[12px] shadow-sm">{kw}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

const inputClass = 'h-9 w-full rounded-full border border-white/60 bg-white/50 px-3 text-[13px] text-slate-800 outline-none transition-colors placeholder:text-slate-400 focus:bg-white focus:border-slate-300';

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[18px] border border-white/60 bg-white/50 px-5 py-4 flex flex-col justify-between h-[90px]">
      <div className="text-[12px] font-medium text-slate-500">{label}</div>
      <div className="text-[26px] font-extrabold text-slate-800">{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

function KnowledgeListItem({ item, onToggleStatus, onEdit, onDelete, onClick }: { item: KnowledgeItem; onToggleStatus: () => void; onEdit: () => void; onDelete: () => void; onClick: () => void }) {
  const meta = categoryMeta[item.category];
  const Icon = meta.icon;

  const stopAndCall = (event: MouseEvent<HTMLElement>, fn: () => void) => {
    event.stopPropagation();
    fn();
  };

  return (
    <div
      className="group flex items-center justify-between p-3 rounded-[14px] border border-transparent bg-white/20 hover:bg-white/60 hover:border-white/80 hover:shadow-sm transition-all"
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-4 text-left"
      >
        <div className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center border border-white/60 shadow-sm ${meta.tone}`}>
          <Icon className="w-4 h-4" />
        </div>

        <div className="min-w-0 max-w-[420px] flex-1">
          <div className="text-[14px] font-extrabold text-slate-800 truncate mb-0.5">{item.title}</div>
          <div className="text-[13px] text-slate-500 truncate">{item.content}</div>
        </div>

        <div className="hidden lg:flex items-center gap-2 shrink-0">
          {item.standardTerm && (
            <span className="inline-flex items-center rounded bg-slate-100/50 border border-slate-200/50 px-2 py-0.5 text-[11px] text-slate-600 truncate max-w-[120px]">
              <span className="text-slate-400 mr-1">标准:</span>{item.standardTerm}
            </span>
          )}
          {item.formula && (
            <span className="inline-flex items-center rounded bg-slate-100/50 border border-slate-200/50 px-2 py-0.5 text-[11px] text-slate-600 truncate max-w-[120px]">
              <span className="text-slate-400 mr-1">口径:</span>{item.formula}
            </span>
          )}
        </div>
      </button>

      <div className="flex items-center gap-4 shrink-0 pl-4 w-[280px]">
        <div className="w-[70px] text-center text-[12px] font-medium text-slate-500">
          {item.priority}
        </div>
        <div className="w-[60px] text-center flex justify-center">
          <span className={`flex w-2 h-2 rounded-full ${item.status === 'active' ? 'bg-emerald-500' : 'bg-slate-300'}`} title={item.status === 'active' ? '启用中' : '已停用'}></span>
        </div>
        <div className="flex w-[90px] items-center justify-end gap-1">
          <button
            type="button"
            onClick={(e) => stopAndCall(e, onEdit)}
            className="grid h-8 w-8 place-items-center rounded-full bg-white border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
            title="编辑"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => stopAndCall(e, onToggleStatus)}
            className="grid h-8 w-8 place-items-center rounded-full bg-white border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
            title={item.status === 'active' ? '点击停用' : '点击启用'}
          >
            <Power className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => stopAndCall(e, onDelete)}
            className="grid h-8 w-8 place-items-center rounded-full bg-white border border-red-100 text-red-400 hover:text-red-600 hover:bg-red-50 hover:border-red-200 transition-colors shadow-sm"
            title="删除"
            aria-label={`删除${item.title}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
