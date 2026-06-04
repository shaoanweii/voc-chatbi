'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { ReportChartType, SmartReport, SmartReportAnalysisGroup, SmartReportChart, SmartReportTable } from '@/lib/types';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  BarChart3 as BarChart3Icon,
  BarChartHorizontal,
  CircleDot,
  FileDown,
  FileImage,
  Lightbulb,
  LineChart as LineChartIcon,
  Loader2,
  MoreHorizontal,
  PieChart as PieChartIcon,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ReportViewProps {
  report: SmartReport;
}

function renderBoldText(text: string): ReactNode {
  if (!text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-extrabold text-[#333333]">{part.slice(2, -2)}</strong>;
    }
    return part || null;
  });
}

const CHART_COLORS = ['#0ea5e9', '#06b6d4', '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#84cc16'];
type ExportFormat = 'png' | 'pdf';
type ReportChartDisplayType = Exclude<ReportChartType, 'table'> | 'horizontalBar';
interface RenderReportCanvasOptions {
  pixelRatio: number;
}

interface ChartTypeOption {
  type: ReportChartDisplayType;
  label: string;
}

const reportChartTypeIcons = {
  bar: BarChart3Icon,
  horizontalBar: BarChartHorizontal,
  line: LineChartIcon,
  pie: PieChartIcon,
  donut: CircleDot,
  stackedBar: BarChart3Icon,
} satisfies Record<ReportChartDisplayType, ComponentType<{ className?: string }>>;

const EXPORT_SAFE_PADDING = 48;
const PDF_MIN_PAGE_SLICE_RATIO = 0.68;
const PDF_PAGE_BREAK_SEARCH_PX = 320;
const PDF_PAGE_BREAK_BAND_PX = 14;
const PDF_PAGE_BREAK_SAMPLE_STEP = 12;

export function ReportView({ report }: ReportViewProps) {
  const reportContentRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState('');
  const finalSummary = report.finalSummary || {
    summary: report.executiveSummary,
    positives: [],
    risks: [],
    actions: report.recommendations,
  };
  const renderCharts = buildRenderableCharts(report);
  const detailTables = (report.tables || []).filter((table) => !isDistributionTable(table));
  const analysisGroups = buildAnalysisGroups(finalSummary, report);
  let sectionIndex = 0;
  const nextOrder = () => getChineseOrder(sectionIndex++);

  const handleExport = async (format: ExportFormat) => {
    const reportNode = reportContentRef.current;
    if (!reportNode || exporting) return;

    setExportError('');
    setExporting(format);
    try {
      if (format === 'png') {
        const canvas = await renderReportCanvas(reportNode, { pixelRatio: 2 });
        downloadDataUrl(canvas.toDataURL('image/png'), buildExportFileName(report.title, 'png'));
      } else {
        const canvas = await renderReportCanvas(reportNode, { pixelRatio: 2 });
        await downloadPdf(canvas, buildExportFileName(report.title, 'pdf'));
      }
    } catch (error) {
      console.error('Export report failed:', error);
      setExportError('导出失败，请稍后重试');
    } finally {
      setExporting(null);
    }
  };

  return (
    <div ref={reportContentRef} className="mt-5 space-y-5">
      <section className="rounded-[22px] border border-white/65 bg-white/58 p-5 shadow-[0_18px_48px_rgba(15,23,42,0.07)] backdrop-blur-xl">
        <div className="flex flex-col items-center text-center">
          <h3 className="text-[22px] font-extrabold leading-tight text-[#0066CC]">{report.title}</h3>
          <p className="mt-2 text-xs text-[#009999]">
            {formatTimeRange(report)} · 样本 {report.recordCount.toLocaleString()} 条
          </p>
        </div>
      </section>

      {report.executiveSummary && (
        <section className="rounded-[22px] border border-white/65 bg-white/54 p-5 shadow-[0_18px_48px_rgba(15,23,42,0.06)] backdrop-blur-xl">
          <SectionTitle order={nextOrder()} title="全文摘要" />
          <p className="text-sm leading-7 text-[#333333]">{renderBoldText(report.executiveSummary)}</p>
        </section>
      )}

      {renderCharts.length > 0 && (
        <section className="space-y-5">
          {renderCharts.map((chart) => (
            <div key={chart.id} className="space-y-3">
              <ReportChartCard chart={chart} order={nextOrder()} />
              <ChartExplanationPanel chart={chart} report={report} />
            </div>
          ))}
        </section>
      )}

      {detailTables.length > 0 && (
        <section className="space-y-4">
          {detailTables.map((table) => (
            <div key={table.id} className="rounded-[22px] border border-white/65 bg-white/52 p-5 shadow-[0_18px_48px_rgba(15,23,42,0.06)] backdrop-blur-xl">
              <SectionTitle order={nextOrder()} title={table.title} />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr>
                      {table.columns.map((column) => (
                        <th key={column} className="border-b border-slate-200/70 px-3 py-2 text-left text-xs font-bold text-[#009999]">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.slice(0, 10).map((row, rowIndex) => (
                      <tr key={`${table.id}-${rowIndex}`}>
                        {table.columns.map((column) => (
                          <td key={column} className="border-b border-slate-100/70 px-3 py-2 text-[#333333]">
                            {String(row[column] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="rounded-[22px] border border-white/65 bg-white/54 p-5 shadow-[0_18px_48px_rgba(15,23,42,0.06)] backdrop-blur-xl">
        <SectionTitle order={nextOrder()} title="模型深度分析" icon={<Lightbulb className="h-4 w-4 text-amber-500" />} />
        <p className="text-sm leading-7 text-[#333333]">{renderBoldText(finalSummary.summary) || '系统已完成数据筛选、维度分布、根因关键词和可视化图表生成，请参阅下方分析组。'}</p>

        <div className="mt-4 grid gap-2 lg:grid-cols-1">
          {analysisGroups.map((group, index) => (
            <SummaryList
              key={group.title}
              title={group.title}
              items={group.points}
              tone={SUMMARY_TONES[index % SUMMARY_TONES.length]}
            />
          ))}
        </div>
      </section>

      {report.recommendations.length > 0 && (
        <section className="rounded-[22px] border border-white/65 bg-white/52 p-5 shadow-[0_18px_48px_rgba(15,23,42,0.06)] backdrop-blur-xl">
          <SectionTitle order={nextOrder()} title="处理建议" icon={<Lightbulb className="h-4 w-4 text-purple-500" />} />
          <div className="space-y-3">
            {report.recommendations.slice(0, 5).map((item, index) => (
              <div key={item} className="flex gap-3 rounded-[16px] bg-white/58 px-3 py-3 text-sm leading-relaxed text-[#333333]">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-50 text-xs font-extrabold text-purple-500">
                  {index + 1}
                </span>
                <span>{renderBoldText(item)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="flex items-center justify-between gap-3 px-1 text-xs font-medium text-[#009999]" data-report-export-hide="true">
        <span>以上分析结论基于数据表前1万行数据，AI 内容仅供参考，请理性辨别。</span>
        <div className="flex items-center gap-2">
          {exportError && <span className="text-[11px] text-rose-400">{exportError}</span>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={Boolean(exporting)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/70 bg-white/65 text-[#009999] shadow-[0_8px_22px_rgba(15,23,42,0.06)] backdrop-blur-xl transition hover:bg-white/90 hover:text-[#333333] disabled:cursor-not-allowed disabled:opacity-60"
                aria-label="报告操作"
              >
                {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[132px] rounded-2xl border-white/70 bg-white/90 p-2 shadow-[0_18px_52px_rgba(15,23,42,0.14)] backdrop-blur-xl">
              <DropdownMenuItem
                disabled={Boolean(exporting)}
                onClick={() => void handleExport('png')}
                className="cursor-pointer rounded-xl text-xs font-semibold text-[#333333]"
              >
                <FileImage className="mr-2 h-3.5 w-3.5 text-blue-500" />
                导出图片
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={Boolean(exporting)}
                onClick={() => void handleExport('pdf')}
                className="cursor-pointer rounded-xl text-xs font-semibold text-[#333333]"
              >
                <FileDown className="mr-2 h-3.5 w-3.5 text-purple-500" />
                导出 PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

function ChartExplanationPanel({ chart, report }: { chart: SmartReportChart; report: SmartReport }) {
  const explanation = (report.chartExplanations || []).find((item) => item.chartId === chart.id);
  const rootCauseText = chart.id === 'root_cause_keywords' ? buildRootCauseExplanation(report) : '';

  return (
    <div className="rounded-[22px] border border-white/65 bg-white/52 p-5 shadow-[0_18px_48px_rgba(15,23,42,0.06)] backdrop-blur-xl">
      <div className="mb-3 text-sm font-extrabold text-[#0066CC]">{explanation?.title || `${chart.title}解读`}</div>
      <p className="text-sm leading-7 text-[#333333]">
        {renderBoldText(explanation?.explanation || rootCauseText || buildFallbackChartExplanation(chart))}
      </p>
    </div>
  );
}

const SUMMARY_TONES = ['blue', 'emerald', 'rose', 'purple'] as const;

function SummaryList({ title, items, tone }: { title: string; items: string[]; tone: (typeof SUMMARY_TONES)[number] }) {
  const toneClass = tone === 'emerald'
    ? 'bg-emerald-50 text-emerald-600'
    : tone === 'rose'
      ? 'bg-rose-50 text-rose-600'
      : tone === 'blue'
        ? 'bg-blue-50 text-blue-600'
        : 'bg-purple-50 text-purple-600';

  return (
    <div className="rounded-[18px] border border-white/70 bg-white/60 p-4">
      <div className={`mb-3 inline-flex rounded-full px-2.5 py-1 text-xs font-extrabold ${toneClass}`}>{title}</div>
      <div className="space-y-2">
        {items.slice(0, 4).map((item) => (
          <div key={item} className="text-sm leading-relaxed text-[#333333]">{renderBoldText(item)}</div>
        ))}
      </div>
    </div>
  );
}

async function renderReportCanvas(target: HTMLElement, options: RenderReportCanvasOptions): Promise<HTMLCanvasElement> {
  const { toCanvas } = await import('html-to-image');
  await waitForExportLayout();

  const exportTarget = createReportExportTarget(target);
  try {
    await waitForExportLayout();

    const width = Math.ceil(Math.max(exportTarget.node.scrollWidth, exportTarget.node.offsetWidth, exportTarget.node.clientWidth));
    const height = Math.ceil(Math.max(exportTarget.node.scrollHeight, exportTarget.node.offsetHeight, exportTarget.node.clientHeight));

    return await toCanvas(exportTarget.node, {
      backgroundColor: '#f8fbff',
      cacheBust: true,
      width,
      height,
      canvasWidth: width,
      canvasHeight: height,
      pixelRatio: options.pixelRatio,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        maxHeight: 'none',
        overflow: 'visible',
        transform: 'none',
        animation: 'none',
        transition: 'none',
      },
      filter: (node) => !(node instanceof HTMLElement && node.dataset.reportExportHide === 'true'),
    });
  } finally {
    exportTarget.container.remove();
  }
}

async function waitForExportLayout() {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function createReportExportTarget(target: HTMLElement): { container: HTMLElement; node: HTMLElement } {
  const sourceWidth = Math.ceil(target.getBoundingClientRect().width || target.scrollWidth || target.clientWidth);
  const wrapper = document.createElement('div');
  wrapper.dataset.reportExportRoot = 'true';
  Object.assign(wrapper.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${sourceWidth}px`,
    maxWidth: 'none',
    margin: '0',
    padding: '0',
    overflow: 'visible',
    background: '#f8fbff',
    pointerEvents: 'none',
    zIndex: '-1',
  });

  const style = document.createElement('style');
  style.textContent = `
    [data-report-export-root],
    [data-report-export-root] * {
      box-sizing: border-box;
      max-height: none !important;
      overflow: visible !important;
      animation: none !important;
      transition: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    [data-report-export-root] svg,
    [data-report-export-root] svg * {
      overflow: visible !important;
    }
  `;

  const clone = target.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-report-export-hide="true"]').forEach((node) => node.remove());
  Object.assign(clone.style, {
    width: '100%',
    maxWidth: 'none',
    height: 'auto',
    minHeight: '0',
    maxHeight: 'none',
    margin: '0',
    paddingBottom: `${EXPORT_SAFE_PADDING}px`,
    overflow: 'visible',
    background: '#f8fbff',
  });

  wrapper.append(style, clone);
  document.body.appendChild(wrapper);

  return { container: wrapper, node: clone };
}

async function downloadPdf(canvas: HTMLCanvasElement, fileName: string) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const contentWidth = pageWidth - margin * 2;
  const contentHeight = pageHeight - margin * 2;
  const pageSliceHeight = Math.floor((contentHeight / contentWidth) * canvas.width);
  const canvasContext = canvas.getContext('2d', { willReadFrequently: true });
  let sourceY = 0;
  let pageIndex = 0;

  while (sourceY < canvas.height) {
    const sliceHeight = findPdfPageSliceHeight(canvas, sourceY, pageSliceHeight, canvasContext);
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = canvas.width;
    pageCanvas.height = sliceHeight;

    const pageContext = pageCanvas.getContext('2d');
    if (!pageContext) {
      throw new Error('Cannot create PDF page canvas');
    }
    pageContext.fillStyle = '#f8fbff';
    pageContext.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    pageContext.drawImage(
      canvas,
      0,
      sourceY,
      canvas.width,
      sliceHeight,
      0,
      0,
      canvas.width,
      sliceHeight,
    );

    if (pageIndex > 0) {
      pdf.addPage();
    }

    const imageHeight = (sliceHeight * contentWidth) / canvas.width;
    pdf.addImage(
      pageCanvas.toDataURL('image/jpeg', 0.9),
      'JPEG',
      margin,
      margin,
      contentWidth,
      imageHeight,
      undefined,
      'FAST',
    );

    sourceY += sliceHeight;
    pageIndex += 1;
  }

  pdf.save(fileName);
}

function findPdfPageSliceHeight(
  canvas: HTMLCanvasElement,
  sourceY: number,
  idealSliceHeight: number,
  canvasContext: CanvasRenderingContext2D | null,
): number {
  const remainingHeight = canvas.height - sourceY;
  const maxSliceHeight = Math.min(idealSliceHeight, remainingHeight);
  if (!canvasContext || remainingHeight <= idealSliceHeight) {
    return maxSliceHeight;
  }

  const minSliceHeight = Math.max(1, Math.floor(idealSliceHeight * PDF_MIN_PAGE_SLICE_RATIO));
  const searchTop = sourceY + Math.max(minSliceHeight, maxSliceHeight - PDF_PAGE_BREAK_SEARCH_PX);
  const searchBottom = sourceY + maxSliceHeight;
  let bestY = searchBottom;
  let bestScore = Number.POSITIVE_INFINITY;

  try {
    for (let y = searchBottom; y >= searchTop; y -= PDF_PAGE_BREAK_SAMPLE_STEP) {
      const score = scorePdfPageBreak(canvasContext, canvas.width, canvas.height, y);
      if (score < bestScore) {
        bestScore = score;
        bestY = y;
        if (score === 0) break;
      }
    }
  } catch {
    return maxSliceHeight;
  }

  return Math.max(1, Math.min(maxSliceHeight, bestY - sourceY));
}

function scorePdfPageBreak(
  context: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  y: number,
): number {
  const bandTop = Math.max(0, Math.floor(y - PDF_PAGE_BREAK_BAND_PX / 2));
  const bandHeight = Math.max(1, Math.min(PDF_PAGE_BREAK_BAND_PX, canvasHeight - bandTop));
  const imageData = context.getImageData(0, bandTop, canvasWidth, bandHeight).data;
  let score = 0;

  for (let row = 0; row < bandHeight; row += 2) {
    for (let x = 0; x < canvasWidth; x += PDF_PAGE_BREAK_SAMPLE_STEP) {
      const index = (row * canvasWidth + x) * 4;
      const alpha = imageData[index + 3];
      if (alpha < 12) continue;

      const red = imageData[index];
      const green = imageData[index + 1];
      const blue = imageData[index + 2];
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      if (luminance < 235) {
        score += 1;
      }
    }
  }

  return score;
}

function downloadDataUrl(dataUrl: string, fileName: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function buildExportFileName(title: unknown, extension: ExportFormat): string {
  const safeTitle = String(title || '智能报告')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '')
    .slice(0, 36) || '智能报告';

  return `${safeTitle}_${formatExportTimestamp(new Date())}.${extension}`;
}

function formatExportTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('');
}

function formatTimeRange(report: SmartReport): string {
  if (report.timeRange?.start && report.timeRange.end) {
    return `${report.timeRange.start} 至 ${report.timeRange.end}`;
  }
  return report.timeRange?.label || '过去一年';
}


function buildFallbackChartExplanation(chart: SmartReportChart): string {
  const measure = chart.measures[0] || '数量';
  const top = chart.data[0];
  if (!top) return `${chart.title}暂无可解读的数据点。`;
  const topValue = chart.type === 'stackedBar'
    ? chart.measures.reduce((sum, item) => sum + Number(top[item] || 0), 0)
    : Number(top[measure] || 0);
  return `${chart.title}显示「${String(top[chart.dimension] || '')}」最高，对应 ${topValue} 条，建议优先围绕该维度继续抽样核查。`;
}

function readRecordCountMetric(report: SmartReport): number {
  const metric = report.metrics.find((item) => item.label === '命中记录');
  const value = Number(metric?.value || 0);
  return Number.isFinite(value) ? value : 0;
}

function buildAnalysisGroups(finalSummary: SmartReport['finalSummary'], report: SmartReport): SmartReportAnalysisGroup[] {
  if (Array.isArray(finalSummary.analysisGroups) && finalSummary.analysisGroups.length > 0) {
    return finalSummary.analysisGroups.filter((group) => group.title && group.points?.length > 0).slice(0, 4);
  }

  const groups: SmartReportAnalysisGroup[] = [];
  if (finalSummary.positives?.length > 0) {
    groups.push({ title: '关键发现', points: finalSummary.positives });
  }
  if (finalSummary.risks?.length > 0) {
    groups.push({ title: '风险线索', points: finalSummary.risks });
  }
  if ((finalSummary.actions?.length || report.recommendations.length) > 0) {
    groups.push({ title: '后续动作', points: finalSummary.actions.length > 0 ? finalSummary.actions : report.recommendations });
  }

  return groups.length > 0 ? groups : [{ title: '分析结论', points: [finalSummary.summary || report.executiveSummary] }];
}

function buildRenderableCharts(report: SmartReport): SmartReportChart[] {
  const distributionTableCharts = (report.tables || [])
    .filter(isDistributionTable)
    .map(tableToPieChart)
    .filter((chart): chart is SmartReportChart => Boolean(chart));
  const rootCauseChart = buildRootCauseChart(report);
  const allCharts = [
    ...(report.charts || []).map(normalizeRenderableChart),
    ...distributionTableCharts,
    rootCauseChart,
  ].filter((chart): chart is SmartReportChart => Boolean(chart));

  const seen = new Set<string>();
  return allCharts.filter((chart) => {
    if (seen.has(chart.id)) return false;
    seen.add(chart.id);
    return true;
  });
}

function normalizeRenderableChart(chart: SmartReportChart): SmartReportChart {
  return chart.type === 'donut' ? { ...chart, type: 'pie' } : chart;
}

function buildRootCauseChart(report: SmartReport): SmartReportChart | undefined {
  if ((report.charts || []).some((chart) => chart.id === 'root_cause_keywords')) return undefined;
  if (!report.rootCauses || report.rootCauses.length === 0) return undefined;

  return {
    id: 'root_cause_keywords',
    title: '根因关键词分布',
    subtitle: '按原声片段关键词提及次数统计',
    type: 'bar',
    dimension: '关键词',
    measures: ['提及次数'],
    data: report.rootCauses.slice(0, 10).map((cause) => ({
      关键词: cause.keyword,
      提及次数: cause.count,
      占比: cause.ratio,
    })),
  };
}

function buildRootCauseExplanation(report: SmartReport): string {
  const top = report.rootCauses?.[0];
  if (!top) return '';
  const evidence = top.evidence?.[0] ? `典型原声样例包含“${top.evidence[0]}”。` : '';
  return `根因关键词中「${top.keyword}」提及最高，共 ${top.count} 次，占样本 ${top.ratio}%。该结果用于定位文本高频线索，不直接等同于真实故障占比，建议结合原声抽样复核。${evidence}`;
}

function isDistributionTable(table: SmartReportTable): boolean {
  const columns = table.columns.map((column) => column.trim());
  return isDistributionTitle(table.title) || columns.includes('占比') || columns.some((column) => /数量|次数|记录数/.test(column));
}

function isDistributionTitle(title: string): boolean {
  return /分布|明细|占比|构成/.test(title);
}

const CHINESE_ORDER = ['一', '二', '三', '四', '五', '六', '七', '八'];

function getChineseOrder(index: number): string {
  return CHINESE_ORDER[index] || `${index + 1}`;
}

function tableToPieChart(table: SmartReportTable): SmartReportChart | undefined {
  const dimension = table.columns.find((column) => !/占比|数量|次数|记录数/.test(column)) || table.columns[0];
  const measure = table.columns.find((column) => /数量|次数|记录数/.test(column)) || table.columns[1];
  if (!dimension || !measure || table.rows.length === 0) return undefined;
  const fullData = table.rows.map((row) => ({
    [dimension]: String(row[dimension] ?? ''),
    [measure]: Number(row[measure] ?? 0),
    占比: parsePercent(row['占比']),
  }));
  const data = fullData.slice(0, 12);
  const totalValue = fullData.reduce((sum, row) => sum + Number(row[measure] || 0), 0);
  const displayedValue = data.reduce((sum, row) => sum + Number(row[measure] || 0), 0);
  const hiddenGroups = Math.max(fullData.length - data.length, 0);

  return {
    id: `${table.id}_chart`,
    title: table.title.replace(/明细$/, '饼图分布'),
    subtitle: '由分布明细自动转为饼图',
    type: 'pie',
    dimension,
    measures: [measure],
    data,
    summary: {
      totalValue,
      displayedValue,
      hiddenValue: Math.max(totalValue - displayedValue, 0),
      totalGroups: fullData.length,
      displayedGroups: data.length,
      hiddenGroups,
      isTruncated: hiddenGroups > 0,
      dimensionName: dimension,
      measureName: measure,
    },
  };
}

function parsePercent(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = Number(String(value ?? '').replace('%', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function SectionTitle({ order, title, icon }: { order: string; title: string; icon?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 text-base font-extrabold text-[#0066CC]">
      {order && <span className="text-[#0066CC]">{order}、</span>}
      {icon}
      {title}
    </div>
  );
}

function buildChartSectionTitle(chart: SmartReportChart): string {
  if (chart.id === 'root_cause_keywords') return '根因关键词分布';

  const dimension = chart.dimension || '';
  const title = chart.title || '';
  if (/车型|车系/.test(dimension) || /车型|车系/.test(title)) return `${shortDimensionName(dimension || title)}问题集中度`;
  if (/四级标签|三级标签|标签/.test(dimension) || /四级标签|三级标签|标签/.test(title)) return `${shortDimensionName(dimension || title)}问题分布`;
  if (/时间|日期|月份|趋势/.test(dimension) || /时间|日期|月份|趋势/.test(title)) return '问题时间趋势';
  if (/渠道|场景|来源/.test(dimension) || /渠道|场景|来源/.test(title)) return `${shortDimensionName(dimension || title)}分布`;
  return title || `${dimension}分布`;
}

function buildReportChartSummaryText(chart: SmartReportChart): string {
  const summary = chart.summary;
  if (!summary) return '';
  const totalText = `完整总量 ${summary.totalValue.toLocaleString()}，共 ${summary.totalGroups.toLocaleString()} 个维度`;
  if (!summary.isTruncated) return totalText;
  return `${totalText}；当前展示 ${summary.displayedGroups.toLocaleString()} 个维度，展示合计 ${summary.displayedValue.toLocaleString()}，未展开 ${summary.hiddenGroups.toLocaleString()} 个维度合计 ${summary.hiddenValue.toLocaleString()}`;
}

function shortDimensionName(value: unknown): string {
  const text = String(value || '');
  return text
    .replace(/^通用/, '')
    .replace(/分布|趋势|分析|数量|Top\s*\d+/gi, '')
    .trim() || text;
}

function truncateAxisLabel(label: string, maxLen = 6): string {
  if (label.length <= maxLen) return label;
  return `${label.slice(0, maxLen)}..`;
}

function formatChartNumber(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString() : String(value ?? '');
}

function normalizeReportDisplayType(type: ReportChartType): ReportChartDisplayType {
  if (type === 'table') return 'bar';
  return type;
}

function getReportChartTypeOptions(chart: SmartReportChart): ChartTypeOption[] {
  if (chart.type === 'stackedBar') return [{ type: 'stackedBar', label: '堆叠柱' }];

  return [
    { type: 'bar', label: '竖柱' },
    { type: 'horizontalBar', label: '横柱' },
    { type: 'line', label: '折线' },
    { type: 'pie', label: '饼图' },
    { type: 'donut', label: '环图' },
  ];
}

function ReportChartCard({ chart, order }: { chart: SmartReportChart; order?: string }) {
  const availableTypes = useMemo(() => getReportChartTypeOptions(chart), [chart]);
  const initialType = normalizeReportDisplayType(chart.type);
  const [displayType, setDisplayType] = useState<ReportChartDisplayType>(
    availableTypes.some((option) => option.type === initialType) ? initialType : availableTypes[0]?.type || 'bar'
  );

  useEffect(() => {
    setDisplayType(availableTypes.some((option) => option.type === initialType) ? initialType : availableTypes[0]?.type || 'bar');
  }, [availableTypes, initialType]);

  const dimension = chart.dimension;
  const measure = chart.measures[0] || '数量';
  const summaryText = buildReportChartSummaryText(chart);
  const stackedMeasures = chart.measures.filter((item) => item && item !== '总计' && item !== '占比');
  const stackedSeries = stackedMeasures.length > 0 ? stackedMeasures : [measure];
  const renderAxisTick = ({ x, y, payload }: { x: number; y: number; payload: { value: string } }) => (
    <text x={x} y={y} dy={16} textAnchor="middle" fill="#64748b" fontSize={12}>
      {truncateAxisLabel(payload.value)}
    </text>
  );

  return (
    <div className="rounded-[22px] border border-white/65 bg-white/54 p-5 shadow-[0_18px_48px_rgba(15,23,42,0.06)] backdrop-blur-xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionTitle order={order || ''} title={buildChartSectionTitle(chart)} icon={<BarChart3Icon className="h-4 w-4 text-blue-500" />} />
          {chart.subtitle && <div className="mt-1 text-xs text-[#009999]">{chart.subtitle}</div>}
          {summaryText && <div className="mt-1 text-xs font-medium text-[#5f6b7a]">{summaryText}</div>}
        </div>
        {availableTypes.length > 1 && (
          <div className="flex shrink-0 items-center gap-1 rounded-full border border-white/70 bg-white/80 p-1 shadow-sm">
            {availableTypes.map((option) => {
              const Icon = reportChartTypeIcons[option.type];
              return (
                <button
                  key={option.type}
                  type="button"
                  onClick={() => setDisplayType(option.type)}
                  className={`grid h-8 w-8 place-items-center rounded-full transition ${
                    displayType === option.type
                      ? 'bg-[#0066CC] text-white shadow-[0_8px_18px_rgba(0,102,204,0.18)]'
                      : 'text-[#009999] hover:bg-white hover:text-[#333333]'
                  }`}
                  aria-label={`切换为${option.label}`}
                  aria-pressed={displayType === option.type}
                  title={`切换为${option.label}`}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={displayType === 'pie' || displayType === 'donut' || displayType === 'horizontalBar' ? '' : 'h-[280px] w-full'}>
        {displayType === 'line' ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart.data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e6edf4" vertical={false} />
              <XAxis dataKey={dimension} tick={renderAxisTick} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
              <Tooltip />
              <Line type="monotone" dataKey={measure} stroke="#6366f1" strokeWidth={2.5} dot={{ fill: '#64cfa6', r: 4, strokeWidth: 0 }} />
            </LineChart>
          </ResponsiveContainer>
        ) : displayType === 'stackedBar' ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart.data} margin={{ top: 8, right: 18, bottom: 8, left: 4 }} maxBarSize={80}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e6edf4" vertical={false} />
              <XAxis dataKey={dimension} tick={renderAxisTick} axisLine={false} tickLine={false} interval={0} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
              <Tooltip formatter={(value: unknown, name: unknown) => [formatChartNumber(value), String(name)]} />
              <Legend wrapperStyle={{ color: '#64748b', fontSize: 12, paddingTop: 8 }} />
              {stackedSeries.map((seriesName, index) => (
                <Bar
                  key={`${chart.id}-${seriesName}`}
                  dataKey={seriesName}
                  stackId="comparison"
                  fill={CHART_COLORS[index % CHART_COLORS.length]}
                  radius={index === stackedSeries.length - 1 ? [8, 8, 0, 0] : [0, 0, 0, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        ) : displayType === 'horizontalBar' ? (
          <div style={{ width: '100%', height: Math.max(280, chart.data.length * 34) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart.data} layout="vertical" margin={{ top: 8, right: 18, bottom: 8, left: 18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e6edf4" horizontal={false} />
                <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis
                  type="category"
                  dataKey={dimension}
                  width={94}
                  tick={{ fill: '#64748b', fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(value) => (String(value).length > 8 ? `${String(value).slice(0, 8)}..` : String(value))}
                />
                <Tooltip />
                <Bar dataKey={measure} radius={[0, 8, 8, 0]}>
                  {chart.data.map((_entry, index) => (
                    <Cell key={`${chart.id}-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : displayType === 'pie' || displayType === 'donut' ? (
          <div>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Tooltip
                  formatter={(value: number, name: string) => {
                    const total = chart.summary?.totalValue ?? chart.data.reduce((sum, d) => {
                      const v = d[measure];
                      return sum + (typeof v === 'number' ? v : 0);
                    }, 0);
                    const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0';
                    return [`${value.toLocaleString()}（${pct}%）`, name || measure];
                  }}
                />
                <Pie
                  data={chart.data}
                  nameKey={dimension}
                  dataKey={measure}
                  cx="50%"
                  cy="50%"
                  innerRadius={displayType === 'donut' ? 60 : 0}
                  outerRadius={92}
                  stroke="none"
                  label={({ name, value, percent }) => `${String(name).length > 6 ? `${String(name).slice(0, 6)}..` : String(name)} ${Number(value).toLocaleString()}（${(percent * 100).toFixed(1)}%）`}
                  labelLine={false}
                >
                  {chart.data.map((_entry, index) => (
                    <Cell key={`${chart.id}-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-2 flex flex-wrap justify-center gap-x-5 gap-y-1.5">
              {chart.data.map((entry, index) => {
                const name = String(entry[dimension] ?? '');
                const val = entry[measure];
                const displayVal = typeof val === 'number' ? val.toLocaleString() : String(val ?? '');
                const total = chart.summary?.totalValue ?? chart.data.reduce((sum, d) => {
                  const v = d[measure];
                  return sum + (typeof v === 'number' ? v : 0);
                }, 0);
                const pct = total > 0 ? ((Number(val || 0) / total) * 100).toFixed(1) : '0';
                return (
                  <div key={index} className="flex items-center gap-1.5 text-xs text-[#009999]">
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
                    />
                    <span className="max-w-[120px] truncate">{name}</span>
                    <span className="font-semibold text-[#333333]">{displayVal}</span>
                    <span className="text-[#009999]">（{pct}%）</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart.data} margin={{ bottom: 8 }} maxBarSize={80} barGap={8}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e6edf4" vertical={false} />
              <XAxis dataKey={dimension} tick={renderAxisTick} axisLine={false} tickLine={false} interval={0} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
              <Tooltip />
              <Bar dataKey={measure} radius={[8, 8, 0, 0]}>
                {chart.data.map((_entry, index) => (
                  <Cell key={`${chart.id}-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
