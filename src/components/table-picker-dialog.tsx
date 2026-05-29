'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  ChevronDown,
  Database,
  Eye,
  FileSpreadsheet,
  Loader2,
  Search,
  Table2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

export interface SmartTableSelection {
  id: string;
  name: string;
  source_type: string;
  source_table_name?: string | null;
  file_name?: string | null;
  physical_table_name?: string | null;
  folder?: string | null;
  columns?: unknown[];
  row_count?: number;
}

interface SmartTableItem extends SmartTableSelection {
  is_enabled: boolean;
}

interface TablePickerDialogProps {
  triggerClassName?: string;
  triggerStyle?: CSSProperties;
  selectedTables?: SmartTableSelection[];
  onSelectedTablesChange?: (tables: SmartTableSelection[]) => void;
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

export function TablePickerDialog({
  triggerClassName,
  triggerStyle,
  selectedTables,
  onSelectedTablesChange,
}: TablePickerDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tables, setTables] = useState<SmartTableItem[]>([]);
  const [localSelectedTables, setLocalSelectedTables] = useState<SmartTableSelection[]>([]);
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [previewChooserOpen, setPreviewChooserOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewData, setPreviewData] = useState<PreviewPayload | null>(null);
  const activeSelectedTables = selectedTables ?? localSelectedTables;
  const selectedIds = useMemo(() => activeSelectedTables.map((table) => table.id), [activeSelectedTables]);
  const firstSelectedTable = activeSelectedTables[0];

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setIsLoading(true);
    fetch('/api/smart-table')
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled && json.success) {
          setTables(
            (json.data as SmartTableItem[]).filter(
              (table) => table.is_enabled && Boolean(table.physical_table_name)
            )
          );
        }
      })
      .catch(() => {
        if (!cancelled) setTables([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const filteredTables = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return tables;

    return tables.filter((table) => {
      const rawName = table.source_table_name || table.file_name || '';
      return (
        table.name.toLowerCase().includes(keyword) ||
        rawName.toLowerCase().includes(keyword) ||
        (table.folder || '').toLowerCase().includes(keyword)
      );
    });
  }, [query, tables]);

  const updateSelectedTables = (nextTables: SmartTableSelection[]) => {
    if (onSelectedTablesChange) {
      onSelectedTablesChange(nextTables);
    } else {
      setLocalSelectedTables(nextTables);
    }
  };

  const toggleTable = (table: SmartTableSelection) => {
    updateSelectedTables(
      selectedIds.includes(table.id)
        ? activeSelectedTables.filter((item) => item.id !== table.id)
        : [...activeSelectedTables, table]
    );
  };

  const selectAllVisible = () => {
    const visibleIds = filteredTables.map((table) => table.id);
    const allVisibleSelected = visibleIds.every((id) => selectedIds.includes(id));
    updateSelectedTables(
      allVisibleSelected
        ? activeSelectedTables.filter((table) => !visibleIds.includes(table.id))
        : [
            ...activeSelectedTables,
            ...filteredTables.filter((table) => !selectedIds.includes(table.id)),
          ]
    );
  };

  const goToDataPrep = () => {
    setOpen(false);
    router.push('/data-prep');
  };

  const openPreviewFlow = () => {
    if (activeSelectedTables.length === 0) {
      setOpen(true);
      return;
    }
    if (activeSelectedTables.length === 1) {
      void loadPreview(activeSelectedTables[0]);
      return;
    }
    setPreviewChooserOpen(true);
  };

  const loadPreview = async (table: SmartTableSelection) => {
    setPreviewChooserOpen(false);
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

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        {selectedIds.length > 0 ? (
          <div
            className={cn(triggerClassName, 'active gap-0 overflow-hidden p-0')}
            style={triggerStyle}
          >
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 px-4"
              onClick={() => setOpen(true)}
            >
              <span className="voc-status-dot" />
              <Table2 className="h-4 w-4 shrink-0" />
              <span className="max-w-[130px] truncate">{firstSelectedTable?.name}</span>
              <span className="shrink-0 text-slate-500">共{selectedIds.length}张表</span>
              <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
            </button>
            <span className="h-full w-px bg-slate-200/80" />
            <button
              type="button"
              className="flex h-full shrink-0 items-center gap-1 px-4 font-semibold transition-colors hover:bg-white/60"
              onClick={openPreviewFlow}
            >
              <Eye className="h-4 w-4" />
              预览
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={cn(triggerClassName)}
            style={triggerStyle}
            onClick={() => setOpen(true)}
          >
            <Table2 className="w-4 h-4" />
            选取数据表
          </button>
        )}

        <DialogContent className="max-w-[760px] gap-0 overflow-hidden rounded-[24px] border-white/50 bg-white/82 p-0 shadow-[0_24px_80px_rgba(15,23,42,0.18)] backdrop-blur-2xl">
        <DialogHeader className="border-b border-slate-100/80 px-6 py-5">
          <div className="flex items-start justify-between gap-5 pr-8">
            <div>
              <DialogTitle className="text-[18px] font-extrabold tracking-tight text-slate-950">
                选取数据表
              </DialogTitle>
              <DialogDescription className="mt-1 text-[13px] text-slate-500">
                勾选本次问数要使用的数据表，支持多选
              </DialogDescription>
            </div>
            <div className="rounded-full border border-purple-100 bg-purple-50/80 px-3 py-1.5 text-xs font-semibold text-purple-600">
              已选 {selectedIds.length}
            </div>
          </div>
        </DialogHeader>

        <div className="px-6 py-4">
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200/70 bg-white/70 px-4 py-3">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索表名、文件名或目录"
              className="min-w-0 flex-1 bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
            />
            {filteredTables.length > 0 && (
              <button
                type="button"
                onClick={selectAllVisible}
                className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-slate-700"
              >
                全选当前
              </button>
            )}
          </div>

          <div className="mt-4 max-h-[360px] overflow-y-auto rounded-2xl border border-slate-100/80 bg-white/52">
            {isLoading ? (
              <div className="flex h-[180px] items-center justify-center text-sm text-slate-400">
                加载中...
              </div>
            ) : filteredTables.length === 0 ? (
              <div className="flex h-[240px] flex-col items-center justify-center">
                <Table2 className="mb-3 h-10 w-10 text-slate-300" />
                <div className="text-sm font-semibold text-slate-400">NoTable</div>
                <button
                  type="button"
                  onClick={goToDataPrep}
                  className="mt-5 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition-all hover:bg-slate-700"
                >
                  前去新增数据源
                </button>
              </div>
            ) : (
              <div className="divide-y divide-slate-100/80">
                {filteredTables.map((table) => {
                  const checked = selectedIds.includes(table.id);
                  const rawName = table.source_table_name || table.file_name || '-';
                  const Icon = table.source_type === 'mysql' ? Database : FileSpreadsheet;

                  return (
                    <div
                      key={table.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleTable(table)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          toggleTable(table);
                        }
                      }}
                      className={cn(
                        'grid w-full cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-3.5 text-left transition-all hover:bg-white/80 focus:outline-none focus:ring-2 focus:ring-purple-300/60',
                        checked && 'bg-purple-50/70'
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleTable(table)}
                        onClick={(event) => event.stopPropagation()}
                        className="rounded-md border-slate-300 data-[state=checked]:border-purple-500 data-[state=checked]:bg-purple-500"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                            <Icon className="h-4 w-4" />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-bold text-slate-900">{table.name}</div>
                            <div className="truncate font-mono text-xs text-slate-400">{rawName}</div>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-slate-400">
                        <span>{table.columns?.length || 0} 字段</span>
                        {checked && <CheckCircle2 className="h-4 w-4 text-purple-500" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="border-t border-slate-100/80 bg-white/48 px-6 py-4">
          <button
            type="button"
            onClick={() => updateSelectedTables([])}
            className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 transition-all hover:bg-slate-100"
          >
            清空
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-slate-700"
          >
            确认
          </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={previewChooserOpen} onOpenChange={setPreviewChooserOpen}>
        <DialogContent className="max-w-[760px] gap-0 overflow-hidden rounded-[24px] border-white/60 bg-white/88 p-0 shadow-[0_24px_80px_rgba(15,23,42,0.18)] backdrop-blur-2xl">
          <DialogHeader className="border-b border-slate-100/80 px-7 py-6">
            <div className="flex items-center justify-between pr-8">
              <DialogTitle className="text-[22px] font-extrabold tracking-tight text-slate-950">
                预览数据表
              </DialogTitle>
            </div>
          </DialogHeader>
          <div className="px-7 py-6">
            <div className="rounded-2xl bg-slate-50/80 p-3">
              {activeSelectedTables.map((table) => (
                <div
                  key={table.id}
                  className="flex h-16 items-center justify-between rounded-xl px-4 transition-all hover:bg-white/80"
                >
                  <div className="min-w-0 truncate text-base font-semibold text-slate-900">
                    {table.name}
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadPreview(table)}
                    className="rounded-full px-4 py-2 text-sm font-bold text-blue-600 transition-all hover:bg-blue-50"
                  >
                    预览
                  </button>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
                  <table
                    className="table-fixed border-separate border-spacing-0 text-left text-xs"
                    style={{ width: getPreviewTableMinWidth(previewData.columns) }}
                  >
                    <thead>
                      <tr>
                        {previewData.columns.map((column) => (
                          <th
                            key={column}
                            className={cn(
                              'sticky top-0 z-30 whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 font-bold text-slate-500 shadow-[0_1px_0_rgba(226,232,240,0.95),0_12px_20px_rgba(15,23,42,0.08)]',
                              getPreviewColumnClass(column)
                            )}
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="[&_tr:first-child_td]:pt-3">
                      {previewData.rows.map((row, rowIndex) => (
                        <tr key={rowIndex} className="hover:bg-slate-50/80">
                          {previewData.columns.map((column) => (
                            <td
                              key={`${rowIndex}-${column}`}
                              className={cn(
                                'whitespace-nowrap border-b border-slate-100 bg-white/72 px-3 py-2 text-slate-700',
                                getPreviewColumnClass(column)
                              )}
                              title={formatCell(row[column])}
                            >
                              <span className="block truncate">{formatCell(row[column])}</span>
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
    </>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function getPreviewColumnClass(column: string): string {
  if (column === '原声') {
    return 'w-[220px] min-w-[220px] max-w-[220px]';
  }
  return 'w-[160px] min-w-[160px] max-w-[160px]';
}

function getPreviewTableMinWidth(columns: string[]): string {
  const width = columns.reduce((total, column) => total + (column === '原声' ? 220 : 160), 0);
  return `${Math.max(width, 960)}px`;
}
