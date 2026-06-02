'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import type { ChartData } from '@/lib/types';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
  LineChart,
  Line,
  Tooltip,
} from 'recharts';
import {
  BarChart3 as BarChart3Icon,
  BarChartHorizontal,
  CircleDot,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
} from 'lucide-react';

interface ChartCardProps {
  data: ChartData;
}

type ChartDisplayType = ChartData['type'] | 'horizontalBar';

interface ChartTypeOption {
  type: ChartDisplayType;
  label: string;
}

interface PieLabelProps {
  cx: number;
  cy: number;
  midAngle: number;
  outerRadius: number;
  percent: number;
  name: string | number;
  value: number;
}

const chartTypeIcons = {
  bar: BarChart3Icon,
  horizontalBar: BarChartHorizontal,
  line: LineChartIcon,
  pie: PieChartIcon,
  donut: CircleDot,
  stackedBar: BarChart3Icon,
} satisfies Record<ChartDisplayType, ComponentType<{ className?: string }>>;

const GRADIENT_COLORS = [
  { id: 'barMint', from: '#9adcc3', to: '#64cfa6' },
  { id: 'barBlue', from: '#b8cef7', to: '#83a7ee' },
  { id: 'barPurple', from: '#d9c6f8', to: '#b69aef' },
  { id: 'barCyan', from: '#bde5f0', to: '#83cbdf' },
  { id: 'barOrange', from: '#f0d4c3', to: '#e4b494' },
];

function getBarFill(index: number): string {
  return `url(#${GRADIENT_COLORS[index % GRADIENT_COLORS.length].id})`;
}

function getSolidColor(index: number): string {
  return GRADIENT_COLORS[index % GRADIENT_COLORS.length].from;
}

const tooltipStyle: React.CSSProperties = {
  backgroundColor: 'rgba(255,255,255,0.96)',
  border: '1px solid rgba(226,232,240,0.8)',
  borderRadius: 12,
  boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
  padding: '8px 12px',
  fontSize: 13,
  color: '#334155',
  backdropFilter: 'blur(12px)',
};

const tooltipCursorStyle = { fill: 'rgba(148,163,184,0.08)' };

const SCROLL_THRESHOLD = 14; // 超过此数量的条目才启用横向滚动
const MIN_ITEM_WIDTH_BAR = 48;
const MIN_ITEM_WIDTH_LINE = 60;

function needsHorizontalScroll(dataLength: number, chartType: ChartDisplayType): boolean {
  if (chartType === 'donut' || chartType === 'pie' || chartType === 'horizontalBar') return false;
  return dataLength > SCROLL_THRESHOLD;
}

function calcChartWidth(dataLength: number, chartType: ChartDisplayType): number {
  if (chartType === 'donut' || chartType === 'pie' || chartType === 'horizontalBar') return 240;
  const itemWidth = chartType === 'line' ? MIN_ITEM_WIDTH_LINE : MIN_ITEM_WIDTH_BAR;
  return dataLength * itemWidth;
}

function getAvailableChartTypes(data: ChartData): ChartTypeOption[] {
  if (data.type === 'stackedBar') return [{ type: 'stackedBar', label: '堆叠柱' }];

  return [
    { type: 'bar', label: '竖柱' },
    { type: 'horizontalBar', label: '横柱' },
    { type: 'line', label: '折线' },
    { type: 'pie', label: '饼图' },
    { type: 'donut', label: '环图' },
  ];
}

function normalizeInitialChartType(type: ChartData['type']): ChartDisplayType {
  return type === 'stackedBar' ? 'stackedBar' : type;
}

const RADIAN = Math.PI / 180;

/** 渲染饼图/环形图外部标签（含折线连接），百分比过小不显示，避免重叠 */
function renderPieLabel(props: PieLabelProps) {
  const { cx, cy, midAngle, outerRadius, percent, name, value } = props;

  if (percent * 100 < 4) return null;

  const sin = Math.sin(-midAngle * RADIAN);
  const cos = Math.cos(-midAngle * RADIAN);

  // 交错距离：根据角度周期性错开标签位置，避免相邻标签重叠
  const stagger = Math.abs(Math.sin(midAngle * 3 * RADIAN)) * 18 + 14;

  const radius = outerRadius + 2;
  const sx = cx + radius * cos;
  const sy = cy + radius * sin;
  const mx = cx + (radius + stagger * 0.5) * cos;
  const my = cy + (radius + stagger * 0.5) * sin;
  const ex = mx + (cos >= 0 ? stagger : -stagger);
  const ey = my;

  const textAnchor = cos >= 0 ? 'start' : 'end';
  const displayName = String(name).length > 6 ? `${String(name).slice(0, 6)}..` : String(name);

  return (
    <g>
      <polyline
        points={`${sx},${sy} ${mx},${my} ${ex},${ey}`}
        stroke="#94a3b8"
        fill="none"
        strokeWidth={1}
      />
      <text
        x={ex + (cos >= 0 ? 4 : -4)}
        y={ey}
        textAnchor={textAnchor}
        dominantBaseline="central"
        fontSize={11}
        fill="#475569"
      >
        <tspan fontWeight={600}>{displayName}</tspan>
        <tspan fill="#334155"> {value.toLocaleString()}</tspan>
        <tspan fill="#94a3b8">（{(percent * 100).toFixed(1)}%）</tspan>
      </text>
    </g>
  );
}

export function ChartCard({ data }: ChartCardProps) {
  const [displayType, setDisplayType] = useState<ChartDisplayType>(() => normalizeInitialChartType(data.type));
  const availableTypes = useMemo(() => getAvailableChartTypes(data), [data]);

  useEffect(() => {
    const nextType = normalizeInitialChartType(data.type);
    setDisplayType(availableTypes.some((option) => option.type === nextType) ? nextType : availableTypes[0]?.type || 'bar');
  }, [availableTypes, data.type]);

  const chartWidth = useMemo(
    () => calcChartWidth(data.data.length, displayType),
    [data.data.length, displayType],
  );

  const needsScroll = needsHorizontalScroll(data.data.length, displayType);

  const chartContent = (
    <>
      <svg width="0" height="0" className="absolute">
        <defs>
          {GRADIENT_COLORS.map((g) => (
            <linearGradient key={g.id} id={g.id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={g.from} stopOpacity={1} />
              <stop offset="100%" stopColor={g.to} stopOpacity={1} />
            </linearGradient>
          ))}
        </defs>
      </svg>

      {displayType === 'bar' && (
        <div style={{ width: '100%', height: 280, minWidth: needsScroll ? chartWidth : undefined }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.data} margin={{ bottom: 8 }} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="#e6edf4" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fill: '#64748b', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                interval={0}
                angle={-35}
                textAnchor="end"
                height={56}
              />
              <YAxis
                tick={{ fill: '#94a3b8', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={40}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                cursor={tooltipCursorStyle}
                formatter={(value: number) => [value.toLocaleString(), data.subtitle || '数量']}
              />
              <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                {data.data.map((_entry, index) => (
                  <Cell key={`cell-${index}`} fill={getBarFill(index)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {displayType === 'horizontalBar' && (
        <div style={{ width: '100%', height: Math.max(280, data.data.length * 34) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.data} layout="vertical" margin={{ top: 8, right: 18, bottom: 8, left: 18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e6edf4" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fill: '#94a3b8', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={92}
                tick={{ fill: '#64748b', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(value) => (String(value).length > 8 ? `${String(value).slice(0, 8)}..` : String(value))}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                cursor={tooltipCursorStyle}
                formatter={(value: number) => [value.toLocaleString(), data.subtitle || '数量']}
              />
              <Bar dataKey="value" radius={[0, 8, 8, 0]}>
                {data.data.map((_entry, index) => (
                  <Cell key={`cell-${index}`} fill={getBarFill(index)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {displayType === 'line' && (
        <div style={{ width: '100%', height: 280, minWidth: needsScroll ? chartWidth : undefined }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e6edf4" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fill: '#64748b', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                interval={0}
                angle={-35}
                textAnchor="end"
                height={56}
              />
              <YAxis
                tick={{ fill: '#94a3b8', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={40}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value: number) => [value.toLocaleString(), data.subtitle || '数量']}
              />
              <Line
                type="linear"
                dataKey="value"
                stroke="#6366f1"
                strokeWidth={2.5}
                dot={{ fill: '#6366f1', r: 3, strokeWidth: 0 }}
                activeDot={{ fill: '#6366f1', r: 5, strokeWidth: 2, stroke: '#fff' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {displayType === 'stackedBar' && (() => {
        const stackKeys = data.series && data.series.length > 0
          ? data.series
          : (() => {
              const firstRow = data.data[0] || {};
              return Object.keys(firstRow).filter((k) => k !== 'name' && k !== 'color' && k !== 'value' && typeof firstRow[k] === 'number');
            })();
        const stackColors = ['#9adcc3', '#83a7ee', '#b69aef', '#83cbdf', '#e4b494', '#f0d4c3', '#d9c6f8', '#bde5f0'];

        return (
          <div style={{ width: '100%', height: 300, minWidth: needsScroll ? chartWidth : undefined }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.data} margin={{ bottom: 8, top: 12 }} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" stroke="#e6edf4" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fill: '#64748b', fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                  angle={-35}
                  textAnchor="end"
                  height={56}
                />
                <YAxis
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  cursor={tooltipCursorStyle}
                  formatter={(value: number, name: string) => [value.toLocaleString(), name]}
                />
                {stackKeys.map((key, index) => (
                  <Bar
                    key={key}
                    dataKey={key}
                    stackId="stack"
                    fill={stackColors[index % stackColors.length]}
                    radius={index === stackKeys.length - 1 ? [6, 6, 0, 0] : [0, 0, 0, 0]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        );
      })()}

      {displayType === 'donut' && (
        <div className="flex flex-col items-center">
          <ResponsiveContainer width={480} height={340}>
            <PieChart margin={{ top: 10, right: 100, bottom: 10, left: 100 }}>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value: number, name: string) => {
                  const total = data.data.reduce((sum, d) => sum + d.value, 0);
                  const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0';
                  return [`${value.toLocaleString()}（${pct}%）`, name || '数量'];
                }}
              />
              <Pie
                data={data.data}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={80}
                dataKey="value"
                nameKey="name"
                stroke="none"
                label={renderPieLabel}
              >
                {data.data.map((_entry, index) => (
                  <Cell key={`cell-${index}`} fill={getSolidColor(index)} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs text-slate-500">
            {data.data.map((entry, index) => {
              const total = data.data.reduce((sum, d) => sum + d.value, 0);
              const pct = total > 0 ? `（${((entry.value / total) * 100).toFixed(1)}%）` : '';
              return (
                <div key={index} className="flex items-center gap-1">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: getSolidColor(index) }}
                  />
                  <span className="max-w-[100px] truncate">{String(entry.name).length > 6 ? `${String(entry.name).slice(0, 6)}..` : String(entry.name)}</span>
                  <span className="font-semibold text-slate-700">{entry.value.toLocaleString()}</span>
                  <span className="text-slate-400">{pct}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {displayType === 'pie' && (
        <div className="flex flex-col items-center">
          <ResponsiveContainer width={480} height={340}>
            <PieChart margin={{ top: 10, right: 100, bottom: 10, left: 100 }}>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value: number, name: string) => {
                  const total = data.data.reduce((sum, d) => sum + d.value, 0);
                  const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0';
                  return [`${value.toLocaleString()}（${pct}%）`, name || '数量'];
                }}
              />
              <Pie
                data={data.data}
                cx="50%"
                cy="50%"
                innerRadius={0}
                outerRadius={80}
                dataKey="value"
                nameKey="name"
                stroke="#fff"
                strokeWidth={2}
                label={renderPieLabel}
              >
                {data.data.map((_entry, index) => (
                  <Cell key={`cell-${index}`} fill={getSolidColor(index)} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs text-slate-500">
            {data.data.map((entry, index) => {
              const total = data.data.reduce((sum, d) => sum + d.value, 0);
              const pct = total > 0 ? `（${((entry.value / total) * 100).toFixed(1)}%）` : '';
              return (
                <div key={index} className="flex items-center gap-1">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: getSolidColor(index) }}
                  />
                  <span className="max-w-[100px] truncate">{String(entry.name).length > 6 ? `${String(entry.name).slice(0, 6)}..` : String(entry.name)}</span>
                  <span className="font-semibold text-slate-700">{entry.value.toLocaleString()}</span>
                  <span className="text-slate-400">{pct}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="voc-chart-card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-extrabold text-slate-950 mb-1">{data.title}</h3>
          <p className="text-xs text-slate-400">{data.subtitle}</p>
        </div>
        {availableTypes.length > 1 && (
          <div className="flex shrink-0 items-center gap-1 rounded-full border border-slate-200/80 bg-white/85 p-1 shadow-sm">
            {availableTypes.map((option) => {
              const Icon = chartTypeIcons[option.type];
              return (
                <button
                  key={option.type}
                  type="button"
                  onClick={() => setDisplayType(option.type)}
                  className={`grid h-8 w-8 place-items-center rounded-full transition ${
                    displayType === option.type
                      ? 'bg-[#0066CC] text-white shadow-[0_8px_18px_rgba(0,102,204,0.18)]'
                      : 'text-slate-500 hover:bg-white hover:text-slate-800'
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

      {needsScroll ? (
        <div
          className="overflow-x-auto rounded-xl"
          style={{
            scrollbarWidth: 'thin',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          <style>{`
            .voc-chart-scroll::-webkit-scrollbar { height: 6px; }
            .voc-chart-scroll::-webkit-scrollbar-track { background: transparent; border-radius: 3px; }
            .voc-chart-scroll::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
            .voc-chart-scroll::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
          `}</style>
          <div className="voc-chart-scroll overflow-x-auto rounded-xl">
            {chartContent}
          </div>
        </div>
      ) : (
        chartContent
      )}
    </div>
  );
}
