'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Plus, Database, FileSpreadsheet, RefreshCw,
  Settings, BookOpen, ToggleLeft, ToggleRight, Trash2,
  ChevronRight, ChevronDown, Eye, Table2, Upload, X,
  CheckCircle2, XCircle, Loader2, FolderOpen, List,
  BarChart3,
} from 'lucide-react';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { ProfileDialog } from '@/components/profile-dialog';
import { useAuthProfile } from '@/components/auth-provider';
import { usePinyinInitial } from '@/hooks/use-pinyin-initial';
import { GlassConfirmDialog } from '@/components/glass-confirm-dialog';

// ============ 类型定义 ============

interface DataSourceItem {
  id: string;
  name: string;
  type: string;
  status: string;
  is_enabled: boolean;
  host?: string | null;
  port?: number | null;
  database_name?: string | null;
  username?: string | null;
  file_name?: string | null;
  file_size?: number | null;
  folder?: string | null;
  remark?: string | null;
  table_count?: number;
  created_at: string;
  updated_at?: string | null;
}

interface SmartTableItem {
  id: string;
  name: string;
  source_id: string;
  source_type: string;
  source_table_name?: string | null;
  file_name?: string | null;
  folder: string;
  remark?: string | null;
  columns: ColumnDef[];
  row_count: number;
  is_enabled: boolean;
  physical_table_name?: string | null;
  sync_status?: string | null;
  sync_job_type?: string | null;
  sync_error_message?: string | null;
  sync_updated_at?: string | null;
  created_at: string;
  updated_at?: string | null;
}

interface ColumnDef {
  name: string;
  type: string;
  source_type: string;
  source_name: string;
  comment?: string;
  default_value?: string;
  date_format?: 'long' | 'short';
}

interface MysqlTableInfo {
  table_name: string;
  table_comment: string;
  table_rows: number;
}

interface GlassNotice {
  type: 'success' | 'error';
  title: string;
  message?: string;
}

// ============ 样式常量 ============

const inputCls = 'w-full px-4 py-2.5 rounded-xl border border-white/30 bg-white/50 backdrop-blur-sm text-sm focus:outline-none focus:border-[#6d5df6] focus:ring-2 focus:ring-[#6d5df6]/20 transition-all';
const btnPrimary = 'px-6 py-2.5 rounded-xl bg-gradient-to-r from-[#1f2937] to-[#334155] text-white text-sm font-medium hover:shadow-lg transition-all';
const btnGhost = 'px-4 py-2 rounded-xl text-xs text-slate-500 hover:bg-white/60 transition-all';

type DBTYPE = 'mysql' | 'hive' | 'sqlserver' | 'clickhouse' | 'selectdb';

interface DbTypePreset {
  label: string;
  defaultPort: number;
  jdbcDesc: string;
}

const DB_TYPE_PRESETS: Record<DBTYPE, DbTypePreset> = {
  mysql: {
    label: 'MySQL',
    defaultPort: 3306,
    jdbcDesc: 'jdbc:mysql://{host}:{port}/{database}',
  },
  hive: {
    label: 'Hive',
    defaultPort: 10000,
    jdbcDesc: 'jdbc:hive2://{host}:{port}/{database}',
  },
  sqlserver: {
    label: 'SQL Server',
    defaultPort: 1433,
    jdbcDesc: 'jdbc:sqlserver://{host}:{port};databaseName={database}',
  },
  clickhouse: {
    label: 'ClickHouse',
    defaultPort: 8123,
    jdbcDesc: 'jdbc:clickhouse://{host}:{port}/{database}',
  },
  selectdb: {
    label: 'SelectDB',
    defaultPort: 9030,
    jdbcDesc: 'jdbc:mysql://{host}:{port}/{database}',
  },
};

const ALL_DB_TYPES: DBTYPE[] = ['mysql', 'hive', 'sqlserver', 'clickhouse', 'selectdb'];

// ============ 页面主体 ============

export default function DataPrepPage() {
  const router = useRouter();

  // 视图状态
  const [view, setView] = useState<'main' | 'new-source' | 'new-table' | 'source-detail' | 'list'>('main');
  const [activePanel, setActivePanel] = useState<'connect' | 'build' | 'manage'>('connect');
  const [mainTab, setMainTab] = useState<'datasource' | 'report' | 'more'>('datasource');
  const [showDsSubMenu, setShowDsSubMenu] = useState(false);
  const [sourceType, setSourceType] = useState<DBTYPE | 'file'>('mysql');
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'source'; id: string } | { type: 'table'; id: string } | null>(null);
  const { profile: userProfile, updateProfileCache } = useAuthProfile();
  const profileInitial = usePinyinInitial(userProfile?.accountName || userProfile?.account);

  // 数据
  const [dataSources, setDataSources] = useState<DataSourceItem[]>([]);
  const [smartTables, setSmartTables] = useState<SmartTableItem[]>([]);
  const [loading, setLoading] = useState(false);

  // 当前选中的数据源
  const [selectedSource, setSelectedSource] = useState<DataSourceItem | null>(null);
  const [editingDataSource, setEditingDataSource] = useState<DataSourceItem | null>(null);
  const [editingSmartTable, setEditingSmartTable] = useState<SmartTableItem | null>(null);

  // 数据源链接表单
  const [connectionForm, setConnectionForm] = useState({
    host: '', port: '3306', database_name: '', username: '', password: '', name: '',
  });
  const dbType = ALL_DB_TYPES.includes(sourceType as DBTYPE) ? (sourceType as DBTYPE) : 'mysql';
  const isDbSource = ALL_DB_TYPES.includes(sourceType as DBTYPE);
  const [testResult, setTestResult] = useState<'idle' | 'testing' | 'success' | 'fail'>('idle');
  const [testError, setTestError] = useState('');

  // MySQL 远程表列表
  const [mysqlTables, setMysqlTables] = useState<MysqlTableInfo[]>([]);
  const [selectedMysqlTable, setSelectedMysqlTable] = useState('');
  const [mysqlTableMeta, setMysqlTableMeta] = useState<{ columns: ColumnDef[]; preview: Array<Record<string, unknown>> } | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);

  // 数据源建表弹窗
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [pickerTables, setPickerTables] = useState<Record<string, MysqlTableInfo[]>>({});
  const [pickerLoading, setPickerLoading] = useState<string | null>(null);

  // 文件上传
  const [fileParseResult, setFileParseResult] = useState<{
    file_key: string; file_name: string; file_size: number;
    columns: ColumnDef[]; rows: Array<Record<string, unknown>>; preview: Array<Record<string, unknown>>;
  } | null>(null);
  const [parsing, setParsing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 建表表单
  const [tableName, setTableName] = useState('');
  const [tableRemark, setTableRemark] = useState('');
  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>([]);
  const [previewData, setPreviewData] = useState<Array<Record<string, unknown>>>([]);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<GlassNotice | null>(null);
  const [dataSourceRuntimeStatus, setDataSourceRuntimeStatus] = useState<Record<string, 'processing' | 'pending'>>({});
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const externalSmartTables = smartTables.filter((table) => !isLocalFileSourceType(table.source_type));

  // ============ 数据加载 ============

  const loadDataSources = useCallback(async () => {
    try {
      const res = await fetch('/api/data-source');
      const json = await res.json();
      if (json.success) setDataSources(json.data);
    } catch (e) {
      console.error('加载数据源失败:', e);
    }
  }, []);

  const loadSmartTables = useCallback(async () => {
    try {
      const res = await fetch('/api/smart-table');
      const json = await res.json();
      if (json.success) setSmartTables(json.data);
    } catch (e) {
      console.error('加载智能表失败:', e);
    }
  }, []);

  useEffect(() => {
    loadDataSources();
    loadSmartTables();
  }, [loadDataSources, loadSmartTables]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const showNotice = useCallback((nextNotice: GlassNotice) => {
    setNotice(nextNotice);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 3200);
  }, []);

  // ============ MySQL 测试连接 ============

  const testConnection = async () => {
    setTestResult('testing');
    setTestError('');
    try {
      const res = await fetch('/api/data-source/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...connectionForm, type: sourceType }),
      });
      const json = await res.json();
      if (json.success) {
        setTestResult('success');
      } else {
        setTestResult('fail');
        setTestError(json.error || '连接失败');
      }
    } catch {
      setTestResult('fail');
      setTestError('网络错误');
    }
  };

  // ============ 保存数据源 ============

  const saveDataSource = async () => {
    setLoading(true);
    try {
      const res = await fetch(editingDataSource ? `/api/data-source?id=${editingDataSource.id}` : '/api/data-source', {
        method: editingDataSource ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...connectionForm, type: sourceType }),
      });
      const json = await res.json();
      if (json.success) {
        await loadDataSources();
        setView('main');
        resetConnectionForm();
        setEditingDataSource(null);
        showNotice({ type: 'success', title: editingDataSource ? '数据源已更新' : '数据源已保存' });
      } else {
        showNotice({ type: 'error', title: '保存失败', message: json.error || '请检查数据源配置' });
      }
    } catch {
      showNotice({ type: 'error', title: '保存失败', message: '网络或服务异常，请稍后重试' });
    } finally {
      setLoading(false);
    }
  };

  // ============ 文件上传 & 解析 ============

  const handleFileUpload = async (file: File) => {
    setParsing(true);
    setFileParseResult(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/data-source/parse-file', {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();
      if (json.success) {
        setFileParseResult(json.data);
        const parsedColumns = (json.data.columns as ColumnDef[]).map((column) => ({
          ...column,
          comment: column.comment || '',
          default_value: column.default_value || '',
          date_format: column.type === 'date' ? column.date_format || 'long' : undefined,
        }));
        setColumnDefs(parsedColumns);
        setPreviewData(json.data.preview);
        setTableName(file.name.replace(/\.(xlsx|xls|csv)$/i, ''));
        // 自动切换到建表视图
        setView('new-table');
        setSourceType('file');
        setSelectedSource(null);
        showNotice({ type: 'success', title: '文件解析完成', message: '已识别字段并生成前 10 条预览' });
      } else {
        showNotice({ type: 'error', title: '解析失败', message: json.error || '请检查文件格式' });
      }
    } catch {
      showNotice({ type: 'error', title: '文件解析失败', message: '仅支持 Excel / CSV 文件' });
    } finally {
      setParsing(false);
    }
  };

  // ============ MySQL 获取远程表 ============

  const loadMysqlTables = async (sourceId: string) => {
    setLoadingTables(true);
    setMysqlTables([]);
    try {
      const res = await fetch(`/api/data-source/${sourceId}/tables`);
      const json = await res.json();
      if (json.success) {
        setMysqlTables(json.data);
      }
    } catch (e) {
      console.error('加载MySQL表失败:', e);
    } finally {
      setLoadingTables(false);
    }
  };

  const loadMysqlTableMeta = async (sourceId: string, tableName: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/data-source/${sourceId}/table-meta?table=${encodeURIComponent(tableName)}`);
      const json = await res.json();
      if (json.success) {
        const cols: ColumnDef[] = (json.data.columns as Array<Record<string, string>>).map((c) => {
          const mappedType = mapMysqlType(c.DATA_TYPE);
          return {
            name: c.COLUMN_NAME,
            type: mappedType,
            source_type: c.DATA_TYPE,
            source_name: c.COLUMN_NAME,
            comment: c.COLUMN_COMMENT || '',
            default_value: '',
            date_format: mappedType === 'date' ? defaultDateFormat(c.DATA_TYPE) : undefined,
          };
        });
        setColumnDefs(cols);
        setPreviewData(json.data.preview as Array<Record<string, unknown>>);
        setMysqlTableMeta({ columns: cols, preview: json.data.preview });
        setSelectedMysqlTable(tableName);
        setTableName(tableName);
      }
    } catch (e) {
      console.error('加载表元数据失败:', e);
    } finally {
      setLoading(false);
    }
  };

  // ============ 数据源建表弹窗 ============

  const openTablePicker = () => {
    setShowTablePicker(true);
    setPickerTables({});
  };

  const loadPickerTables = async (sourceId: string) => {
    setPickerLoading(sourceId);
    try {
      const res = await fetch(`/api/data-source/${sourceId}/tables`);
      const json = await res.json();
      if (json.success) {
        setPickerTables((prev) => ({ ...prev, [sourceId]: json.data }));
      }
    } catch (e) {
      console.error('加载表列表失败:', e);
    } finally {
      setPickerLoading(null);
    }
  };

  const selectTableFromPicker = async (ds: DataSourceItem, tableName: string) => {
    setSelectedSource(ds);
    setSourceType((ALL_DB_TYPES as string[]).includes(ds.type) ? (ds.type as DBTYPE) : 'mysql');
    setShowTablePicker(false);
    await loadMysqlTableMeta(ds.id, tableName);
    setView('new-table');
  };

  // ============ 创建智能表 ============

  const createSmartTable = async () => {
    if (!tableName || columnDefs.length === 0) return;

    if (editingSmartTable) {
      await updateSmartTableMetadata();
      return;
    }

    // 文件来源需要先创建数据源记录
    let sourceId = isDbSource ? selectedSource?.id : undefined;
    if (sourceType === 'file' && fileParseResult && !sourceId) {
      // 自动创建文件类型数据源
      try {
        const res = await fetch('/api/data-source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: tableName.trim(),
            type: 'file',
            file_key: fileParseResult.file_key,
            file_name: fileParseResult.file_name,
            file_size: fileParseResult.file_size,
          }),
        });
        const json = await res.json();
        if (json.success) {
          sourceId = json.data.id;
          await loadDataSources();
        } else {
          showNotice({ type: 'error', title: '创建数据源失败', message: json.error || '文件数据源保存失败' });
          return;
        }
      } catch {
        showNotice({ type: 'error', title: '创建数据源失败', message: '网络或服务异常，请稍后重试' });
        return;
      }
    }

    if (!sourceId) {
      showNotice({ type: 'error', title: '创建失败', message: '缺少数据源信息，请重新选择数据源' });
      return;
    }

    setCreating(true);
    const currentSourceId = sourceId;
    setDataSourceRuntimeStatus((prev) => ({ ...prev, [currentSourceId]: 'processing' }));
    setView('main');
    setActivePanel('manage');
    showNotice({ type: 'success', title: '建表任务已提交', message: '正在创建中间表并导入数据，可在数据源列表查看进度' });
    try {
      const res = await fetch('/api/smart-table', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: tableName,
          source_id: sourceId,
          source_type: sourceType,
          source_table_name: isDbSource ? selectedMysqlTable : null,
          file_key: sourceType === 'file' ? fileParseResult?.file_key : null,
          file_name: sourceType === 'file' ? fileParseResult?.file_name : null,
          file_rows: sourceType === 'file' ? fileParseResult?.rows || [] : undefined,
          remark: tableRemark,
          columns: columnDefs,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setDataSourceRuntimeStatus((prev) => {
          const next = { ...prev };
          delete next[currentSourceId];
          return next;
        });
        await loadSmartTables();
        resetCreateTableForm();
        setView('main');
        setActivePanel('manage');
        showNotice({ type: 'success', title: '智能问数表创建成功', message: '中间表已创建并完成数据导入' });
      } else {
        setDataSourceRuntimeStatus((prev) => ({ ...prev, [currentSourceId]: 'pending' }));
        await loadSmartTables();
        showNotice({ type: 'error', title: '创建失败', message: toFriendlyError(json.error) });
      }
    } catch {
      setDataSourceRuntimeStatus((prev) => ({ ...prev, [currentSourceId]: 'pending' }));
      await loadSmartTables();
      showNotice({ type: 'error', title: '创建失败', message: '网络或服务异常，请稍后重试' });
    } finally {
      setCreating(false);
    }
  };

  const updateSmartTableMetadata = async () => {
    if (!editingSmartTable || !tableName || columnDefs.length === 0) return;

    setCreating(true);
    try {
      const res = await fetch(`/api/smart-table?id=${editingSmartTable.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: tableName,
          remark: tableRemark,
          columns: columnDefs,
        }),
      });
      const json = await res.json();

      if (json.success) {
        if (selectedSource && isLocalFileSourceType(selectedSource.type)) {
          await fetch(`/api/data-source?id=${selectedSource.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: tableName, remark: tableRemark }),
          }).catch(() => undefined);
        }
        await loadSmartTables();
        await loadDataSources();
        resetCreateTableForm();
        setView('main');
        setActivePanel('manage');
        showNotice({ type: 'success', title: '字段信息已更新', message: '列名称和业务描述已保存' });
      } else {
        showNotice({ type: 'error', title: '保存失败', message: toFriendlyError(json.error) });
      }
    } catch {
      showNotice({ type: 'error', title: '保存失败', message: '网络或服务异常，请稍后重试' });
    } finally {
      setCreating(false);
    }
  };

  // ============ 切换启用/禁用 ============

  const toggleDataSource = async (id: string, isEnabled: boolean) => {
    try {
      await fetch('/api/data-source?id=' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: !isEnabled }),
      });
      await loadDataSources();
    } catch (e) {
      console.error('切换状态失败:', e);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const { type, id } = deleteTarget;
    try {
      if (type === 'source') {
        await fetch('/api/data-source?id=' + id, { method: 'DELETE' });
        await loadDataSources();
      } else {
        await fetch('/api/smart-table?id=' + id, { method: 'DELETE' });
        await loadSmartTables();
        await loadDataSources();
        showNotice({ type: 'success', title: '智能问数表已删除' });
      }
    } catch (e) {
      console.error('删除失败:', e);
      showNotice({ type: 'error', title: '删除失败', message: '网络或服务异常，请稍后重试' });
    }
    setDeleteTarget(null);
  };

  const deleteDataSource = (id: string) => {
    setDeleteTarget({ type: 'source', id });
  };

  // ============ 重置 ============

  const resetConnectionForm = () => {
    const preset = DB_TYPE_PRESETS[dbType];
    setConnectionForm({ host: '', port: String(preset.defaultPort), database_name: '', username: '', password: '', name: '' });
    setTestResult('idle');
    setTestError('');
    setEditingDataSource(null);
  };

  const resetCreateTableForm = () => {
    setTableName('');
    setTableRemark('');
    setColumnDefs([]);
    setPreviewData([]);
    setMysqlTableMeta(null);
    setSelectedMysqlTable('');
    setFileParseResult(null);
    setSelectedSource(null);
    setEditingSmartTable(null);
  };

  // ============ 辅助 ============

  function mapMysqlType(dataType: string): string {
    const t = dataType.toLowerCase();
    if (['int', 'bigint', 'tinyint', 'smallint', 'mediumint', 'integer'].includes(t)) return 'integer';
    if (['decimal', 'float', 'double', 'numeric'].includes(t)) return 'number';
    if (['date', 'datetime', 'timestamp', 'time'].includes(t)) return 'date';
    return 'string';
  }

  function defaultDateFormat(dataType: string): 'long' | 'short' {
    return dataType.toLowerCase() === 'date' ? 'short' : 'long';
  }

  function defaultValuePlaceholder(type: string, dateFormat?: 'long' | 'short'): string {
    if (type === 'integer') return '如 0';
    if (type === 'number') return '如 0.00';
    if (type === 'date') return dateFormat === 'short' ? 'YYYY-MM-DD' : 'YYYY-MM-DD hh:mm:ss';
    return '空值时使用';
  }

  function formatTime(iso: string | null | undefined): string {
    if (!iso) return '-';
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function formatFileSize(bytes: number | null | undefined): string {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function toFriendlyError(message?: string): string {
    if (!message) return '中间表创建失败';
    if (message.includes('sync_jobs_job_type_check')) return '处理任务状态配置未同步，请刷新后重试';
    if (message.includes('violates check constraint')) return '数据状态校验未通过，请检查字段配置后重试';
    return message.length > 90 ? `${message.slice(0, 90)}...` : message;
  }

  function getDataSourceStatus(ds: DataSourceItem): { label: string; className: string } {
    const runtimeStatus = dataSourceRuntimeStatus[ds.id];
    if (runtimeStatus === 'processing') {
      return { label: '处理中', className: 'bg-amber-100/80 text-amber-600' };
    }
    if (runtimeStatus === 'pending') {
      return { label: '待处理', className: 'bg-slate-100/90 text-slate-500' };
    }
    const relatedTables = smartTables.filter((table) => table.source_id === ds.id);
    if (relatedTables.some((table) => table.sync_status === 'pending' || table.sync_status === 'running')) {
      return { label: '处理中', className: 'bg-amber-100/80 text-amber-600' };
    }
    if (relatedTables.some((table) => table.sync_status === 'failed')) {
      return { label: '待处理', className: 'bg-slate-100/90 text-slate-500' };
    }
    if (!ds.is_enabled) {
      return { label: '停用', className: 'bg-[#ffe8ec] text-[#8a5560]' };
    }
    return { label: '在线', className: 'bg-[#ddf7ec] text-[#28755d]' };
  }

  function getDataSourceDisplayName(ds: DataSourceItem): string {
    if (isLocalFileSourceType(ds.type)) {
      const relatedTable = smartTables.find((table) => table.source_id === ds.id);
      return relatedTable?.name || ds.name;
    }
    return ds.name;
  }

  function getSmartTableStatus(table: SmartTableItem): { label: string; className: string } {
    if (table.sync_status === 'pending' || table.sync_status === 'running') {
      return { label: '处理中', className: 'bg-amber-100/80 text-amber-600' };
    }
    if (table.sync_status === 'failed') {
      return { label: '待处理', className: 'bg-slate-100/90 text-slate-500' };
    }
    if (!table.is_enabled) {
      return { label: '停用', className: 'bg-[#ffe8ec] text-[#8a5560]' };
    }
    return { label: '已建表', className: 'bg-[#ddf7ec] text-[#28755d]' };
  }

  const typeOptions = ['string', 'integer', 'number', 'date'];
  const typeLabels: Record<string, string> = {
    string: '字符串',
    integer: '整数',
    number: '数值',
    date: '日期',
  };

  const openDbSourceForm = (type: DBTYPE = 'mysql') => {
    setSourceType(type);
    setConnectionForm({
      host: '', port: String(DB_TYPE_PRESETS[type].defaultPort), database_name: '', username: '', password: '', name: '',
    });
    setTestResult('idle');
    setTestError('');
    setView('new-source');
  };

  const openFileUploadForm = () => {
    setFileParseResult(null);
    setSourceType('file');
    setView('new-source');
  };

  const editDataSource = async (ds: DataSourceItem) => {
    setEditingDataSource(ds);
    setEditingSmartTable(null);
    const dbType = (ALL_DB_TYPES as string[]).includes(ds.type) ? (ds.type as DBTYPE) : null;
    setSourceType(dbType || 'file');

    if (isLocalFileSourceType(ds.type)) {
      const relatedTable = smartTables.find((table) => table.source_id === ds.id);
      if (!relatedTable) {
        showNotice({ type: 'error', title: '未找到智能问数表', message: '该文件还没有生成可编辑的中间表' });
        return;
      }

      setSourceType('file');
      setSelectedSource(ds);
      setEditingSmartTable(relatedTable);
      setTableName(relatedTable.name);
      setTableRemark(relatedTable.remark || '');
      setColumnDefs(normalizeEditableColumns(relatedTable.columns));
      setFileParseResult({
        file_key: '',
        file_name: relatedTable.file_name || ds.file_name || ds.name,
        file_size: ds.file_size || 0,
        columns: normalizeEditableColumns(relatedTable.columns),
        rows: [],
        preview: [],
      });
      setPreviewData([]);

      try {
        const res = await fetch(`/api/smart-table/${relatedTable.id}/preview`);
        const json = await res.json();
        if (json.success && Array.isArray(json.data?.rows)) {
          setPreviewData(json.data.rows.slice(0, 10));
        }
      } catch {
        // 编辑字段信息不依赖预览数据。
      }

      setView('new-table');
      return;
    }

    setConnectionForm({
      host: ds.host || '',
      port: String(ds.port || 3306),
      database_name: ds.database_name || '',
      username: ds.username || '',
      password: '',
      name: ds.name || '',
    });
    setTestResult('idle');
    setTestError('');
    setView('new-source');
  };

  const editSmartTable = async (table: SmartTableItem) => {
    const source = dataSources.find((ds) => ds.id === table.source_id) || null;
    setEditingDataSource(null);
    setEditingSmartTable(table);
    setSelectedSource(source);
    const dbType = (ALL_DB_TYPES as string[]).includes(table.source_type) ? (table.source_type as DBTYPE) : null;
    setSourceType(dbType || 'file');
    setSelectedMysqlTable(table.source_table_name || '');
    setTableName(table.name);
    setTableRemark(table.remark || '');
    setColumnDefs(normalizeEditableColumns(table.columns));
    setPreviewData([]);
    setFileParseResult(
      isLocalFileSourceType(table.source_type)
        ? {
            file_key: '',
            file_name: table.file_name || source?.file_name || table.name,
            file_size: source?.file_size || 0,
            columns: normalizeEditableColumns(table.columns),
            rows: [],
            preview: [],
          }
        : null
    );

    try {
      const res = await fetch(`/api/smart-table/${table.id}/preview`);
      const json = await res.json();
      if (json.success && Array.isArray(json.data?.rows)) {
        setPreviewData(json.data.rows.slice(0, 10));
      }
    } catch {
      // 编辑字段信息不依赖预览数据。
    }

    setView('new-table');
  };

  // ============ 建表表单（共用组件）============

  function renderCreateTableForm() {
    return (
      <div className="space-y-4">
        {/* 基本信息 */}
        <div className="p-5 rounded-2xl bg-white/68 backdrop-blur-xl border border-white/40">
          <h3 className="text-sm font-semibold text-[#0f172a] mb-4">基本信息</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-500 mb-1.5">显示名称 <span className="text-red-400">*</span></label>
              <input className={inputCls} value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="请输入数据表显示名称" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1.5">备注（选填）</label>
              <input className={inputCls} value={tableRemark} onChange={(e) => setTableRemark(e.target.value)} placeholder="请输入数据表备注" />
            </div>
          </div>
          {isDbSource && selectedMysqlTable && (
            <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
              <Database className="w-3.5 h-3.5" />
              <span>来源: {selectedSource?.name} / <span className="font-mono">{selectedMysqlTable}</span></span>
            </div>
          )}
          {sourceType === 'file' && fileParseResult && (
            <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>来源: {fileParseResult.file_name} ({formatFileSize(fileParseResult.file_size)})</span>
            </div>
          )}
        </div>

        {/* 字段映射 */}
        <div className="p-5 rounded-2xl bg-white/68 backdrop-blur-xl border border-white/40">
          <h3 className="text-sm font-semibold text-[#0f172a] mb-4">字段映射</h3>
          <div className="overflow-x-auto">
            <table className="min-w-[1320px] w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 border-b border-slate-100">
                  <th className="w-[190px] text-left py-2 pr-3 font-medium">原始字段名</th>
                  <th className="w-[120px] text-left py-2 pr-3 font-medium">原始类型</th>
                  <th className="w-[240px] text-left py-2 pr-3 font-medium">显示名称</th>
                  <th className="w-[140px] text-left py-2 pr-3 font-medium">数据类型</th>
                  <th className="w-[150px] text-left py-2 pr-3 font-medium">日期格式</th>
                  <th className="w-[220px] text-left py-2 font-medium">默认值</th>
                  <th className="w-[260px] text-left py-2 pl-3 font-medium">备注</th>
                </tr>
              </thead>
              <tbody>
                {columnDefs.map((col, i) => (
                  <tr key={`${col.source_name}-${i}`} className="border-b border-slate-50/60">
                    <td className="py-2 pr-3 font-mono text-xs text-slate-600">{col.source_name}</td>
                    <td className="py-2 pr-3 text-xs text-slate-400">{col.source_type}</td>
                    <td className="py-2 pr-3">
                      <input
                        className={inputCls + ' !py-1.5 !text-xs'}
                        value={col.name}
                        onChange={(e) => {
                          const updated = [...columnDefs];
                          updated[i] = { ...updated[i], name: e.target.value };
                          setColumnDefs(updated);
                        }}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <select
                        className={inputCls + ' !py-1.5 !text-xs'}
                        value={col.type}
                        onChange={(e) => {
                          const nextType = e.target.value;
                          const updated = [...columnDefs];
                          updated[i] = {
                            ...updated[i],
                            type: nextType,
                            date_format: nextType === 'date' ? updated[i].date_format || 'long' : undefined,
                          };
                          setColumnDefs(updated);
                        }}
                      >
                        {typeOptions.map((t) => (
                          <option key={t} value={t}>{typeLabels[t]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 pr-3">
                      {col.type === 'date' ? (
                        <select
                          className={inputCls + ' !py-1.5 !text-xs'}
                          value={col.date_format || 'long'}
                          onChange={(e) => {
                            const updated = [...columnDefs];
                            updated[i] = { ...updated[i], date_format: e.target.value as 'long' | 'short' };
                            setColumnDefs(updated);
                          }}
                        >
                          <option value="long">长日期</option>
                          <option value="short">短日期</option>
                        </select>
                      ) : (
                        <span className="inline-flex h-[34px] items-center text-xs text-slate-300">-</span>
                      )}
                    </td>
                    <td className="py-2">
                      <input
                        className={inputCls + ' !py-1.5 !text-xs'}
                        value={col.default_value || ''}
                        placeholder={defaultValuePlaceholder(col.type, col.date_format)}
                        onChange={(e) => {
                          const updated = [...columnDefs];
                          updated[i] = { ...updated[i], default_value: e.target.value };
                          setColumnDefs(updated);
                        }}
                      />
                    </td>
                    <td className="py-2 pl-3">
                      <input
                        className={inputCls + ' !py-1.5 !text-xs'}
                        value={col.comment || ''}
                        placeholder="描述字段业务含义"
                        onChange={(e) => {
                          const updated = [...columnDefs];
                          updated[i] = { ...updated[i], comment: e.target.value };
                          setColumnDefs(updated);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 数据预览 */}
        {previewData.length > 0 && (
          <div className="p-5 rounded-2xl bg-white/68 backdrop-blur-xl border border-white/40">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[#0f172a]">数据预览</h3>
              <span className="text-xs text-slate-400">前 {previewData.length} 条</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-100">
                    {columnDefs.map((col) => (
                      <th key={col.name} className="text-left py-2 px-3 font-medium whitespace-nowrap">{col.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewData.map((row, i) => (
                    <tr key={i} className="border-b border-slate-50/40 hover:bg-white/30">
                      {columnDefs.map((col) => (
                        <td key={col.name} className="py-1.5 px-3 text-slate-600 whitespace-nowrap max-w-[200px] truncate">{String(row[col.source_name] ?? row[col.name] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 创建按钮 */}
        <div className="flex justify-end gap-3 pt-2">
          <button onClick={() => { setView('main'); resetCreateTableForm(); }} className={btnGhost}>取消</button>
          <button onClick={createSmartTable} disabled={creating || !tableName || columnDefs.length === 0} className={btnPrimary + ' disabled:opacity-40 flex items-center gap-2'}>
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {creating ? (editingSmartTable ? '保存中...' : '创建中...') : (editingSmartTable ? '保存字段信息' : '创建智能问数表')}
          </button>
        </div>
      </div>
    );
  }

  // ============ 智能表操作 ============

  async function toggleSmartTable(id: string, isEnabled: boolean) {
    try {
      await fetch('/api/smart-table?id=' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: !isEnabled }),
      });
      await loadSmartTables();
      showNotice({ type: 'success', title: isEnabled ? '智能问数表已禁用' : '智能问数表已启用' });
    } catch (e) {
      console.error('切换状态失败:', e);
      showNotice({ type: 'error', title: '状态切换失败', message: '网络或服务异常，请稍后重试' });
    }
  }

  function deleteSmartTable(id: string) {
    setDeleteTarget({ type: 'table', id });
  }

  // ============ 渲染 ============

  return (
    <TooltipProvider>
      <div className="min-h-screen min-w-[1280px] overflow-x-auto bg-[radial-gradient(circle_at_16%_12%,rgba(202,247,231,0.56),transparent_31%),radial-gradient(circle_at_84%_9%,rgba(229,216,255,0.58),transparent_32%),radial-gradient(circle_at_65%_92%,rgba(211,236,248,0.68),transparent_36%),linear-gradient(145deg,#ffffff_0%,#f8fafc_46%,#eef6fb_100%)] text-[#0f172a] relative">
      {/* 版权信息 - 放在最外层容器内，使用fixed定位 */}
      <footer className="fixed bottom-8 left-1/2 -translate-x-1/2 text-slate-400 text-[13px] text-center pointer-events-none z-50">
        <div>版权所有 © 富通科技 2026</div>
      </footer>
      <div className="pointer-events-none fixed inset-0 opacity-[0.34] [background:linear-gradient(90deg,rgba(221,231,241,0.55)_1px,transparent_1px)_0_0/120px_120px,linear-gradient(0deg,rgba(221,231,241,0.55)_1px,transparent_1px)_0_0/120px_120px] [mask-image:radial-gradient(circle_at_center,#000_0%,transparent_72%)]" />
      <div className="pointer-events-none fixed left-[172px] top-[162px] h-[330px] w-[330px] rounded-full bg-[rgba(201,243,228,0.38)] blur-[26px]" />
      <div className="pointer-events-none fixed right-[168px] top-[158px] h-[340px] w-[340px] rounded-full bg-[rgba(232,220,255,0.40)] blur-[26px]" />
      {notice && (
        <div className="fixed right-8 top-8 z-[80] w-[360px] rounded-[24px] border border-white/70 bg-white/72 p-4 shadow-[0_28px_80px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.82)] backdrop-blur-2xl" style={{ animation: 'vocEnter 220ms ease-out' }}>
          <div className="flex gap-3">
            <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${
              notice.type === 'success'
                ? 'bg-emerald-100/80 text-emerald-600'
                : 'bg-rose-100/80 text-rose-600'
            }`}>
              {notice.type === 'success' ? <CheckCircle2 className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-extrabold text-slate-800">{notice.title}</div>
              {notice.message && <div className="mt-1 text-xs leading-5 text-slate-500">{notice.message}</div>}
            </div>
            <button type="button" onClick={() => setNotice(null)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-all hover:bg-white/70 hover:text-slate-600">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
      {/* 返回箭头 - 独立放置，不影响 header 布局 */}
      <div className="fixed left-4 top-4 z-50">
        <button onClick={() => view === 'main' ? router.push('/chatbi') : setView('main')} className="w-10 h-10 rounded-full bg-white/70 flex items-center justify-center text-slate-500 backdrop-blur-sm hover:bg-white/90 transition-all shadow-sm">
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

      <GlassConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={deleteTarget?.type === 'source' ? '删除数据源' : '删除智能问数表'}
        description={deleteTarget?.type === 'source' ? '确认删除此数据源？删除后关联的智能问数表及物理数据表也将被删除。' : '确认删除此智能问数表？删除后对应的物理数据表也将被清理。'}
        onConfirm={handleConfirmDelete}
      />
      
      {/* 顶部导航 - 与首页保持一致 */}
      <header className="sticky top-4 z-20 mx-auto max-w-[1320px] min-w-[1100px] px-10">
        <div className="rounded-3xl px-5 py-3.5 flex items-center justify-between bg-transparent">
          <div className="flex items-center gap-1">
            <img src="/assets/futonglogo.png" alt="富通科技" className="h-8 w-auto object-contain" />
          </div>
          <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => router.push('/chatbi')} className="w-10 h-10 rounded-full bg-white/50 flex items-center justify-center text-slate-500 backdrop-blur-sm hover:bg-white/80 transition-all">
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

      {/* 功能模块 Tab 栏 - logo 下方居中 */}
      <div className="sticky top-8 z-30 mx-auto flex flex-col items-center pt-4 pb-2">
        {/* 一级 Tab */}
        <div className="inline-flex items-center gap-1 rounded-2xl border border-slate-200/70 bg-white/80 p-1.5 backdrop-blur-xl shadow-[0_4px_20px_rgba(15,23,42,0.06)]">
          {/* 数据源管理 - hover 展示子菜单 */}
          <div
            className="relative"
            onMouseEnter={() => { setMainTab('datasource'); setShowDsSubMenu(true); }}
            onMouseLeave={() => setShowDsSubMenu(false)}
          >
            <button
              onClick={() => {
                if (view !== 'main') setView('main');
                setMainTab('datasource');
              }}
              className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-semibold transition-all ${
                mainTab === 'datasource'
                  ? 'bg-[linear-gradient(135deg,#6366f1_0%,#8b5cf6_100%)] text-white shadow-[0_2px_10px_rgba(99,102,241,0.30)]'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100/80'
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              数据源管理
              <ChevronDown className={`w-3 h-3 transition-transform ${showDsSubMenu ? 'rotate-180' : ''}`} />
            </button>
            {showDsSubMenu && (
               <div className="absolute left-1/2 -translate-x-1/2 top-full pt-1.5 inline-flex items-center gap-1 rounded-xl border border-slate-100 bg-white/95 p-1 shadow-[0_20px_60px_rgba(15,23,42,0.12)] backdrop-blur-2xl z-50">
                {[
                  { key: 'connect' as const, label: '数据源接入' },
                  { key: 'build' as const, label: '数据源建表' },
                  { key: 'manage' as const, label: '数据源列表' },
                ].map((sub) => (
                  <button
                    key={sub.key}
                    onClick={() => { setActivePanel(sub.key); setShowDsSubMenu(false); }}
                    className={`whitespace-nowrap rounded-lg px-3.5 py-1.5 text-[12px] font-medium transition-all ${
                      activePanel === sub.key
                        ? 'bg-white text-[#6d5df6] shadow-sm'
                        : 'text-slate-500 hover:text-slate-700 hover:bg-white/70'
                    }`}
                  >
                    {sub.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 数据报表 */}
          <button
            onClick={() => router.push('/voc_data_report')}
            className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-semibold transition-all ${
              mainTab === 'report'
                ? 'bg-[linear-gradient(135deg,#6366f1_0%,#8b5cf6_100%)] text-white shadow-[0_2px_10px_rgba(99,102,241,0.30)]'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100/80'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            数据报表
          </button>

          {/* 更多功能 */}
          <button
            onClick={() => setMainTab('more')}
            className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-semibold transition-all ${
              mainTab === 'more'
                ? 'bg-[linear-gradient(135deg,#6366f1_0%,#8b5cf6_100%)] text-white shadow-[0_2px_10px_rgba(99,102,241,0.30)]'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100/80'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            更多功能
          </button>
        </div>
      </div>

      <div className="relative z-10 mx-auto w-[90vw] max-w-[1680px] pb-16 pt-8">
        {/* ====== 主视图 ====== */}
        {view === 'main' && (
          <div style={{ animation: 'vocEnter 360ms ease-out' }}>
            {activePanel === 'connect' && (
              <section className="mx-auto grid w-[1040px] grid-cols-2 gap-7">
                <article
                  role="button"
                  tabIndex={0}
                  onClick={() => openDbSourceForm()}
                  onPointerDown={(event) => {
                    if (event.button === 0) openDbSourceForm();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openDbSourceForm();
                    }
                  }}
                  className="group relative h-[250px] cursor-pointer overflow-hidden rounded-[28px] border border-white/90 bg-white/65 p-7 text-left shadow-[0_28px_80px_-14px_rgba(15,23,42,0.13),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-xl transition-all hover:-translate-y-1"
                >
                  <div className="absolute -right-[38px] -top-[52px] h-[238px] w-[238px] rounded-full bg-[rgba(199,249,233,0.76)] opacity-90 blur-[2px]" />
                  <div className="pointer-events-none absolute inset-px rounded-[27px] bg-[linear-gradient(135deg,rgba(255,255,255,0.50),transparent_44%)]" />
                  <div className="relative z-[1] grid h-full grid-cols-[1fr_145px] gap-5">
                    <div>
                      <h3 className="mb-2 text-[22px] font-extrabold leading-[1.24]">数据源接入</h3>
                      <p className="text-sm leading-[1.65] text-slate-500">企业自有一方数据库接入，连通性测试</p>
                      <div className="mt-5 flex flex-wrap gap-2">
                        {ALL_DB_TYPES.map((type) => (
                          <button
                            key={type}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openDbSourceForm(type);
                            }}
                            className="inline-flex h-7 items-center whitespace-nowrap rounded-full border border-slate-200/80 bg-white/65 px-2.5 text-xs font-bold text-slate-500 hover:border-[#6d5df6]/40 hover:text-[#6d5df6] transition-all"
                          >
                            {DB_TYPE_PRESETS[type].label}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openDbSourceForm();
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          if (event.button === 0) openDbSourceForm();
                        }}
                        className="mt-5 inline-flex h-10 items-center justify-center rounded-full bg-[linear-gradient(135deg,#1f2937,#334155)] px-4 text-sm font-extrabold text-white shadow-[0_16px_34px_rgba(15,23,42,0.16)] transition-all hover:-translate-y-0.5"
                      >
                        连接数据库
                      </button>
                    </div>
                    <div className="relative self-center justify-self-end h-[140px] w-[140px] -rotate-[5deg]" aria-hidden="true">
                      <div className="absolute left-[22px] top-6 h-24 w-24 rounded-[50%/18%] bg-[radial-gradient(ellipse_at_50%_16%,rgba(255,255,255,0.98)_0_34%,rgba(199,249,233,0.90)_35%_44%,transparent_45%),linear-gradient(145deg,#c8f2e2,#88d8bb_48%,#5ccca2)] shadow-[0_24px_44px_rgba(73,177,143,0.22)] before:absolute before:left-2.5 before:top-7 before:h-5 before:w-[76px] before:rounded-full before:border-2 before:border-white/60 after:absolute after:left-2.5 after:top-[58px] after:h-5 after:w-[76px] after:rounded-full after:border-2 after:border-white/60" />
                      <div className="absolute left-[65px] top-1.5 h-10 w-[54px] rounded-2xl bg-[linear-gradient(135deg,#f7fffb,#d9f8ec)] shadow-[0_14px_28px_rgba(15,23,42,0.10)] before:absolute before:left-4 before:top-3 before:h-4 before:w-1.5 before:rounded-full before:bg-[#64cfa6] after:absolute after:right-4 after:top-3 after:h-4 after:w-1.5 after:rounded-full after:bg-[#64cfa6]" />
                    </div>
                  </div>
                </article>

                <article
                  role="button"
                  tabIndex={0}
                  onClick={openFileUploadForm}
                  onPointerDown={(event) => {
                    if (event.button === 0) openFileUploadForm();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openFileUploadForm();
                    }
                  }}
                  className="group relative h-[250px] cursor-pointer overflow-hidden rounded-[28px] border border-white/90 bg-white/65 p-7 text-left shadow-[0_28px_80px_-14px_rgba(15,23,42,0.13),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-xl transition-all hover:-translate-y-1"
                >
                  <div className="absolute -right-[38px] -top-[52px] h-[238px] w-[238px] rounded-full bg-[rgba(227,239,248,0.92)] opacity-90 blur-[2px]" />
                  <div className="pointer-events-none absolute inset-px rounded-[27px] bg-[linear-gradient(135deg,rgba(255,255,255,0.50),transparent_44%)]" />
                  <div className="relative z-[1] grid h-full grid-cols-[1fr_145px] gap-5">
                    <div>
                      <h3 className="mb-2 text-[22px] font-extrabold leading-[1.24]">本地文件上传</h3>
                      <p className="text-sm leading-[1.65] text-slate-500">本地文件上传。支持 Excel / CSV 拖拽解析，自动识别表头、数据类型。</p>
                      <div className="mt-5 flex flex-wrap gap-2">
                        {['Excel', 'CSV', '一键建表'].map((tag) => (
                          <span key={tag} className="inline-flex h-7 items-center whitespace-nowrap rounded-full border border-slate-200/80 bg-white/65 px-2.5 text-xs font-bold text-slate-500">{tag}</span>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openFileUploadForm();
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          if (event.button === 0) openFileUploadForm();
                        }}
                        className="mt-5 inline-flex h-10 items-center justify-center rounded-full bg-[linear-gradient(135deg,#1f2937,#334155)] px-4 text-sm font-extrabold text-white shadow-[0_16px_34px_rgba(15,23,42,0.16)] transition-all hover:-translate-y-0.5"
                      >
                        上传并建表
                      </button>
                    </div>
                    <div className="relative self-center justify-self-end h-[140px] w-[140px]" aria-hidden="true">
                      <div className="absolute left-6 top-[18px] h-[110px] w-[92px] rounded-[24px] bg-[linear-gradient(145deg,#ffffff,#e3eff8_56%,#bde5f0)] shadow-[0_24px_44px_rgba(76,141,171,0.20)] before:absolute before:right-0 before:top-0 before:rounded-tr-[22px] before:rounded-bl-xl before:border-b-[26px] before:border-l-[26px] before:border-b-[rgba(141,195,214,0.46)] before:border-l-transparent" />
                      <div className="absolute left-[52px] top-[52px] text-[50px] font-black leading-none text-[#315d7c] shadow-[0_12px_24px_rgba(49,93,124,0.18)]">↑</div>
                    </div>
                  </div>
                </article>
              </section>
            )}

            {activePanel === 'build' && (
              <section className="mx-auto w-full rounded-[32px] border border-white/90 bg-white/65 p-9 shadow-[0_28px_80px_-14px_rgba(15,23,42,0.13),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-xl">
                <div className="mb-[18px] flex items-center justify-between">
                  <div>
                    <h3 className="text-2xl font-extrabold text-[#0f172a]">数据源建表</h3>
                    <p className="mt-2 text-base text-slate-500">从已链接的外部数据源选择表，创建映射到智能问数的中间表</p>
                  </div>
                  <button onClick={openTablePicker} className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[linear-gradient(135deg,#111827,#334155)] px-5 text-sm font-extrabold text-white shadow-[0_16px_34px_rgba(15,23,42,0.18)]">
                    <Table2 className="h-4 w-4" /> 选择数据表
                  </button>
                </div>
                <div className="rounded-[20px] border border-slate-200/80 bg-slate-50/70 p-4">
                  {externalSmartTables.length === 0 ? (
                    <div className="py-16 text-center">
                      <Table2 className="mx-auto mb-3 h-10 w-10 text-slate-300" />
                      <p className="text-sm font-bold text-slate-400">暂无从外部数据源创建的智能问数表</p>
                    </div>
                  ) : (
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200/80 text-left text-xs font-extrabold text-slate-400">
                          <th className="h-10">表名称</th>
                          <th>来源</th>
                          <th>行数</th>
                          <th>状态</th>
                          <th className="text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {externalSmartTables.map((table) => {
                          const tableStatus = getSmartTableStatus(table);
                          return (
                            <tr key={table.id} className={`border-b border-slate-100/90 last:border-b-0 transition-all hover:bg-white/50 ${!table.is_enabled ? 'opacity-50' : ''}`}>
                              <td className="h-[64px] text-sm font-extrabold text-slate-900">{table.name}</td>
                              <td className="text-xs font-mono text-slate-500">{table.source_table_name || table.file_name || '-'}</td>
                              <td className="text-sm text-slate-500">{table.row_count}</td>
                              <td>
                                <span className={`inline-flex h-7 items-center rounded-full px-2.5 text-xs font-extrabold ${tableStatus.className}`}>
                                  {tableStatus.label}
                                </span>
                              </td>
                              <td className="text-right">
                                <button onClick={() => toggleSmartTable(table.id, table.is_enabled)} className="mr-2 inline-grid h-[30px] w-[30px] place-items-center rounded-[10px] border border-slate-200 bg-white/75 text-slate-500 transition-all hover:bg-white" title={table.is_enabled ? '禁用' : '启用'}>
                                  {table.is_enabled ? <ToggleRight className="w-5 h-5 text-emerald-500" /> : <ToggleLeft className="w-5 h-5 text-slate-300" />}
                                </button>
                                <button onClick={() => editSmartTable(table)} className="mr-2 inline-grid h-[30px] w-[30px] place-items-center rounded-[10px] border border-slate-200 bg-white/75 text-slate-500 transition-all hover:bg-white" title="修改">
                                  <Settings className="h-4 w-4" />
                                </button>
                                <button onClick={() => deleteSmartTable(table.id)} className="inline-grid h-[30px] w-[30px] place-items-center rounded-[10px] border border-slate-200 bg-white/75 text-[#ef6b73] transition-all hover:bg-white" title="删除">
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>
            )}

            {activePanel === 'manage' && (
              <section className="mx-auto w-full rounded-[32px] border border-white/90 bg-white/65 p-9 shadow-[0_28px_80px_-14px_rgba(15,23,42,0.13),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-xl">
                <div className="mb-[18px] flex items-center justify-between">
                  <div>
                    {/* <h3 className="text-2xl font-extrabold text-[#0f172a]">数据源列表</h3> */}
                    {/* <p className="mt-2 text-base text-slate-500">查看、修改、禁用或删除已连接的数据源信息</p> */}
                  </div>
                  <button onClick={() => openDbSourceForm()} className="inline-flex h-8 items-center gap-2 rounded-full border border-slate-200 bg-slate-50/70 px-3 text-xs font-extrabold text-slate-500">
                    <Plus className="h-4 w-4" /> 新增
                  </button>
                </div>
                {dataSources.length === 0 ? (
                  <div className="rounded-[20px] border border-slate-200/80 bg-slate-50/70 px-6 py-14 text-center">
                    <Database className="mx-auto mb-3 h-11 w-11 text-slate-300" />
                    <p className="text-sm text-slate-400">暂无已链接数据源</p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-[20px] border border-slate-100/80 bg-white/40">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200/80 text-left text-xs font-extrabold text-slate-400">
                          <th className="h-10 px-5">数据源</th>
                          <th className="px-4">类型</th>
                          <th className="px-4">源名称</th>
                          <th className="px-4">状态</th>
                          <th className="px-4">更新时间</th>
                          <th className="px-5 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dataSources.map((ds) => {
                          const sourceStatus = getDataSourceStatus(ds);
                          return (
                            <tr key={ds.id} className={`border-b border-slate-100/90 last:border-b-0 transition-all hover:bg-white/50 ${!ds.is_enabled ? 'opacity-50' : ''}`}>
                              <td className="h-[72px] px-5">
                                <div className="flex items-center gap-3 text-sm font-extrabold text-slate-900">
                                  <span className="grid h-[38px] w-[38px] place-items-center rounded-[14px] bg-white shadow-[0_10px_24px_rgba(15,23,42,0.055)]">
                                    {(ALL_DB_TYPES as string[]).includes(ds.type) ? <Database className="h-4 w-4 text-[#28755d]" /> : <FileSpreadsheet className="h-4 w-4 text-[#315d7c]" />}
                                  </span>
                                  {getDataSourceDisplayName(ds)}
                                </div>
                              </td>
                              <td className="px-4 text-sm text-slate-500">{(ALL_DB_TYPES as string[]).includes(ds.type) ? (DB_TYPE_PRESETS[ds.type as DBTYPE]?.label || ds.type) : 'Excel/CSV'}</td>
                              <td className="px-4 font-mono text-xs text-slate-500">{ds.database_name || ds.file_name || '-'}</td>
                              <td className="px-4">
                                <span className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-extrabold ${sourceStatus.className}`}>
                                  {sourceStatus.label}
                                </span>
                              </td>
                              <td className="px-4 text-xs text-slate-400">{formatTime(ds.updated_at)}</td>
                              <td className="px-5 text-right">
                                <button onClick={() => toggleDataSource(ds.id, ds.is_enabled)} className="mr-2 inline-grid h-[30px] w-[30px] place-items-center rounded-[10px] border border-slate-200 bg-white/75 text-slate-500 transition-all hover:bg-white" title={ds.is_enabled ? '禁用' : '启用'}>
                                  {ds.is_enabled ? <ToggleRight className="w-5 h-5 text-emerald-500" /> : <ToggleLeft className="w-5 h-5 text-slate-300" />}
                                </button>
                                <button onClick={() => editDataSource(ds)} className="mr-2 inline-grid h-[30px] w-[30px] place-items-center rounded-[10px] border border-slate-200 bg-white/75 text-slate-500 transition-all hover:bg-white" title="修改">
                                  <Settings className="h-4 w-4" />
                                </button>
                                <button onClick={() => deleteDataSource(ds.id)} className="inline-grid h-[30px] w-[30px] place-items-center rounded-[10px] border border-slate-200 bg-white/75 text-[#ef6b73] transition-all hover:bg-white" title="删除">
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {/* <p className="mt-16 text-center text-xs font-medium text-slate-400">PRO Engine v3.0</p> */}
          </div>
        )}

        {/* ====== 新建数据源 ====== */}
        {view === 'new-source' && (
          <div className="max-w-2xl mx-auto space-y-6" style={{ animation: 'vocEnter 360ms ease-out' }}>
            <h2 className="text-lg font-bold text-[#0f172a] text-center">
              {isDbSource
                ? editingDataSource ? '修改数据源' : '创建数据源链接'
                : '本地文件上传'}
            </h2>

            {/* 数据库类型选择器 + 连接表单 */}
            {isDbSource && (
              <div className="space-y-4 p-6 rounded-2xl bg-slate-100/80 backdrop-blur-xl border border-white/50">
                {/* 选择数据源 */}
                <div className="rounded-xl bg-[#e2e7ee]/80 px-4 py-2.5">
                  <span className="text-[11px] font-semibold text-slate-600 mr-3">选择数据源：</span>
                  <span className="inline-flex flex-wrap gap-1.5 align-middle">
                    {ALL_DB_TYPES.map((type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          setSourceType(type);
                          setConnectionForm((f) => ({ ...f, port: String(DB_TYPE_PRESETS[type].defaultPort) }));
                        }}
                        disabled={!!editingDataSource}
                        className={`inline-flex items-center rounded-md px-3 py-1 text-[11px] font-bold transition-all ${
                          sourceType === type
                            ? 'bg-[linear-gradient(135deg,#111827,#334155)] text-white shadow-sm'
                            : 'bg-white/70 text-slate-400 hover:bg-white hover:text-slate-600'
                        } ${editingDataSource ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                      >
                        {DB_TYPE_PRESETS[type].label}
                      </button>
                    ))}
                  </span>
                </div>

                {/* JDBC 连接串预览 */}
                <div className="rounded-xl bg-[#e2e7ee]/80 px-4 py-2.5 font-mono text-[11px] text-slate-400">
                  <span className="font-semibold text-slate-500 mr-1">JDBC:</span>
                  {DB_TYPE_PRESETS[dbType].jdbcDesc
                    .replace('{host}', connectionForm.host || 'host')
                    .replace('{port}', connectionForm.port || String(DB_TYPE_PRESETS[dbType].defaultPort))
                    .replace('{database}', connectionForm.database_name || 'database')}
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label className="block text-xs text-slate-500 mb-1.5">主机地址</label>
                    <input className={inputCls} placeholder="192.168.1.100" value={connectionForm.host} onChange={(e) => setConnectionForm((f) => ({ ...f, host: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1.5">端口</label>
                    <input className={inputCls} placeholder={String(DB_TYPE_PRESETS[dbType].defaultPort)} value={connectionForm.port} onChange={(e) => setConnectionForm((f) => ({ ...f, port: e.target.value }))} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">数据库名</label>
                  <input className={inputCls} placeholder={dbType === 'hive' ? 'default' : dbType === 'sqlserver' ? 'AdventureWorks' : 'voc_data'} value={connectionForm.database_name} onChange={(e) => setConnectionForm((f) => ({ ...f, database_name: e.target.value }))} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1.5">用户名</label>
                    <input className={inputCls} placeholder={dbType === 'clickhouse' ? 'default' : 'root'} value={connectionForm.username} onChange={(e) => setConnectionForm((f) => ({ ...f, username: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1.5">密码</label>
                    <input className={inputCls} type="password" placeholder="****" value={connectionForm.password} onChange={(e) => setConnectionForm((f) => ({ ...f, password: e.target.value }))} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">显示名称</label>
                  <input className={inputCls} placeholder={`${DB_TYPE_PRESETS[dbType].label} 数据源`} value={connectionForm.name} onChange={(e) => setConnectionForm((f) => ({ ...f, name: e.target.value }))} />
                </div>

                {/* 测试连接 */}
                <div className="flex items-center gap-3">
                  <button onClick={testConnection} disabled={testResult === 'testing'} className={btnGhost + ' border border-white/30 bg-white/40 backdrop-blur-sm flex items-center gap-2'}>
                    {testResult === 'testing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    测试连接
                  </button>
                  {testResult === 'success' && <span className="flex items-center gap-1 text-emerald-600 text-sm"><CheckCircle2 className="w-4 h-4" /> 连接成功</span>}
                  {testResult === 'fail' && <span className="flex items-center gap-1 text-red-500 text-sm"><XCircle className="w-4 h-4" /> {testError}</span>}
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button onClick={() => { setView('main'); resetConnectionForm(); }} className={btnGhost}>取消</button>
                  <button onClick={saveDataSource} disabled={loading || (!editingDataSource && testResult !== 'success')} className={btnPrimary + ' disabled:opacity-40'}>
                    {loading ? '保存中...' : editingDataSource ? '保存修改' : '保存数据源'}
                  </button>
                </div>
              </div>
            )}

            {/* 文件上传表单 */}
            {sourceType === 'file' && (
              <div className="space-y-5 p-6 rounded-2xl bg-white/68 backdrop-blur-xl border border-white/40">
                <h3 className="text-sm font-bold text-[#0f172a] mb-1">上传本地文件</h3>

                {/* 上传区域 */}
                <div
                  className="relative border-2 border-dashed border-white/50 rounded-xl p-8 text-center hover:border-[#6d5df6]/50 transition-colors cursor-pointer bg-white/30"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={(e) => {
                    e.preventDefault(); e.stopPropagation();
                    const f = e.dataTransfer.files[0];
                    if (f) handleFileUpload(f);
                  }}
                >
                  <Upload className="w-8 h-8 mx-auto text-slate-400 mb-3" />
                  <p className="text-sm text-slate-600">点击上传或拖拽文件到此处</p>
                  <p className="text-xs text-slate-400 mt-1">支持 xlsx、csv 格式，文件最大 500MB</p>
                  <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); }} />
                </div>

                {/* 解析中 */}
                {parsing && (
                  <div className="flex items-center gap-2 text-sm text-slate-500 mt-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> 文件上传并解析中...
                  </div>
                )}

                <div className="flex justify-end pt-2">
                  <button onClick={() => { setView('main'); setFileParseResult(null); }} className={btnGhost}>取消</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ====== 从数据源建表弹窗 ====== */}
        {showTablePicker && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setShowTablePicker(false)}>
            <div className="w-full max-w-lg mx-4 rounded-2xl bg-white/90 backdrop-blur-2xl border border-white/50 shadow-2xl" onClick={(e) => e.stopPropagation()} style={{ animation: 'vocEnter 360ms ease-out' }}>
              <div className="px-6 py-5 border-b border-slate-100/60 flex items-center justify-between">
                <h3 className="text-base font-bold text-[#0f172a]">选择数据表</h3>
                <button onClick={() => setShowTablePicker(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-4 h-4" /></button>
              </div>
              <div className="px-6 py-4 max-h-[60vh] overflow-y-auto space-y-4">
                {dataSources.filter((ds) => (ALL_DB_TYPES as string[]).includes(ds.type) && ds.is_enabled).length === 0 ? (
                  <div className="py-8 text-center">
                    <Database className="w-10 h-10 mx-auto text-slate-300 mb-3" />
                    <p className="text-sm text-slate-400">暂无可用的数据库数据源</p>
                    <p className="text-xs text-slate-300 mt-1">请先新建并启用一个数据库数据源</p>
                  </div>
                ) : (
                  dataSources.filter((ds) => (ALL_DB_TYPES as string[]).includes(ds.type) && ds.is_enabled).map((ds) => (
                    <div key={ds.id}>
                      <div className="flex items-center gap-2 mb-2">
                        <Database className="w-4 h-4 text-blue-500" />
                        <span className="text-sm font-semibold text-[#0f172a]">{ds.name}</span>
                        <span className="text-xs text-slate-400 font-mono">{ds.database_name}</span>
                      </div>
                      {pickerLoading === ds.id ? (
                        <div className="flex items-center gap-2 text-sm text-slate-400 py-3 pl-6"><Loader2 className="w-4 h-4 animate-spin" /> 加载表列表...</div>
                      ) : pickerTables[ds.id] ? (
                        <div className="pl-6 space-y-0.5">
                          {pickerTables[ds.id].length === 0 ? (
                            <p className="text-xs text-slate-400 py-2">未找到表</p>
                          ) : (
                            pickerTables[ds.id].map((t: { table_name: string; table_comment?: string }) => (
                              <button
                                key={t.table_name}
                                onClick={() => selectTableFromPicker(ds, t.table_name)}
                                className="w-full text-left px-3 py-2 rounded-xl text-sm transition-all flex items-center gap-2 hover:bg-[#6d5df6]/5 group"
                              >
                                <ChevronRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-[#6d5df6] transition-colors" />
                                <span className="font-mono text-xs text-slate-600">{t.table_name}</span>
                                {t.table_comment && <span className="text-xs text-slate-400 truncate">({t.table_comment})</span>}
                              </button>
                            ))
                          )}
                        </div>
                      ) : (
                        <button
                          onClick={() => loadPickerTables(ds.id)}
                          className="ml-6 text-xs text-[#6d5df6] hover:underline flex items-center gap-1 py-1"
                        >
                          <ChevronRight className="w-3 h-3" /> 展开表列表
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ====== 数据源列表视图 ====== */}
        {view === 'list' && (
          <div className="animate-in fade-in duration-300">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-[#0f172a]">数据源列表</h2>
                <p className="text-sm text-slate-400 mt-1">管理所有已创建的数据源连接</p>
              </div>
              <button onClick={() => { setView('new-source'); resetConnectionForm(); }} className={btnPrimary + ' flex items-center gap-2'}>
                <Plus className="w-4 h-4" /> 新建数据源
              </button>
            </div>
            {dataSources.length === 0 ? (
              <div className="text-center py-16 voc-glass rounded-2xl">
                <Database className="w-10 h-10 mx-auto text-slate-300 mb-3" />
                <p className="text-sm text-slate-400">暂无数据源</p>
                <p className="text-xs text-slate-300 mt-1">点击上方按钮创建第一个数据源</p>
              </div>
            ) : (
              <div className="voc-glass rounded-2xl overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/30">
                      <th className="text-left text-xs font-semibold text-slate-500 px-4 py-3">数据库类型</th>
                      <th className="text-left text-xs font-semibold text-slate-500 px-4 py-3">源名称</th>
                      <th className="text-left text-xs font-semibold text-slate-500 px-4 py-3">显示名称</th>
                      <th className="text-left text-xs font-semibold text-slate-500 px-4 py-3">创建时间</th>
                      <th className="text-left text-xs font-semibold text-slate-500 px-4 py-3">更新时间</th>
                      <th className="text-right text-xs font-semibold text-slate-500 px-4 py-3">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dataSources.map((ds) => (
                      <tr key={ds.id} className={`border-b border-white/20 hover:bg-white/30 transition-all ${!ds.is_enabled ? 'opacity-50' : ''}`}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {(ALL_DB_TYPES as string[]).includes(ds.type) ? <Database className="w-4 h-4 text-blue-500" /> : <FileSpreadsheet className="w-4 h-4 text-emerald-500" />}
                            <span className="text-sm text-slate-600">{(ALL_DB_TYPES as string[]).includes(ds.type) ? (DB_TYPE_PRESETS[ds.type as DBTYPE]?.label || ds.type) : 'Excel/CSV'}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600 font-mono">{(ALL_DB_TYPES as string[]).includes(ds.type) ? ds.database_name : ds.file_name || '-'}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-[#0f172a]">{getDataSourceDisplayName(ds)}</span>
                            {ds.is_enabled ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600">活跃</span>
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-400">已禁用</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-500">{formatTime(ds.created_at)}</td>
                        <td className="px-4 py-3 text-sm text-slate-500">{ds.updated_at ? formatTime(ds.updated_at) : '-'}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button onClick={() => toggleDataSource(ds.id, ds.is_enabled)} className="p-1.5 rounded-lg hover:bg-white/50 transition-all" title={ds.is_enabled ? '禁用' : '启用'}>
                              {ds.is_enabled ? <ToggleRight className="w-5 h-5 text-emerald-500" /> : <ToggleLeft className="w-5 h-5 text-slate-400" />}
                            </button>
                            {(ALL_DB_TYPES as string[]).includes(ds.type) && (
                              <button onClick={() => openTablePicker()} className="p-1.5 rounded-lg hover:bg-white/50 transition-all" title="建表">
                                <Table2 className="w-4 h-4 text-[#6d5df6]" />
                              </button>
                            )}
                            <button onClick={() => deleteDataSource(ds.id)} className="p-1.5 rounded-lg hover:bg-red-50 transition-all" title="删除">
                              <Trash2 className="w-4 h-4 text-red-400" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ====== 建表表单视图 ====== */}
        {view === 'new-table' && (
          <div className="mx-auto w-full max-w-[1240px] space-y-6" style={{ animation: 'vocEnter 360ms ease-out' }}>
            <div className="flex items-center gap-3">
              <button onClick={() => { setView('main'); resetCreateTableForm(); }} className="p-2 rounded-xl hover:bg-white/60 text-slate-400 transition-all">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-lg font-bold text-[#0f172a]">{editingSmartTable ? '修改智能问数表' : '新建智能问数表'}</h2>
              {isDbSource && selectedSource && selectedMysqlTable && (
                <span className="text-xs text-slate-400 flex items-center gap-1.5 ml-2">
                  <Database className="w-3.5 h-3.5" /> {selectedSource.name} / <span className="font-mono">{selectedMysqlTable}</span>
                </span>
              )}
              {sourceType === 'file' && fileParseResult && (
                <span className="text-xs text-slate-400 flex items-center gap-1.5 ml-2">
                  <FileSpreadsheet className="w-3.5 h-3.5" /> {fileParseResult.file_name}
                </span>
              )}
            </div>
            {renderCreateTableForm()}
          </div>
        )}
      </div>
    </div>
    </TooltipProvider>
  );
}

function isLocalFileSourceType(sourceType: string): boolean {
  return ['file', 'excel', 'csv'].includes(sourceType.toLowerCase());
}

function normalizeEditableColumns(columns: unknown): ColumnDef[] {
  if (!Array.isArray(columns)) return [];

  return columns
    .map((column): ColumnDef | null => {
      if (!column || typeof column !== 'object') return null;
      const raw = column as Record<string, unknown>;
      const name = String(raw.name || '').trim();
      const sourceName = String(raw.source_name || raw.sourceName || name).trim();
      if (!name || !sourceName) return null;

      return {
        name,
        type: String(raw.type || 'string'),
        source_type: String(raw.source_type || raw.sourceType || raw.type || 'string'),
        source_name: sourceName,
        comment: raw.comment ? String(raw.comment) : '',
        default_value: raw.default_value ? String(raw.default_value) : raw.defaultValue ? String(raw.defaultValue) : '',
        date_format: raw.date_format === 'short' || raw.dateFormat === 'short' ? 'short' : 'long',
      };
    })
    .filter((column): column is ColumnDef => Boolean(column));
}
