export type DataSourceType = 'mysql' | 'file' | 'history';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  chart?: ChartData;
  report?: SmartReport;
  sql?: string;
  pythonCode?: string;
  sources?: string[];
  followUps?: string[];
  timestamp: number;
}

export interface ChartData {
  title: string;
  subtitle: string;
  type: 'bar' | 'donut' | 'line' | 'pie' | 'stackedBar';
  data: ChartDataItem[];
  series?: string[];
  summary?: ChartDataSummary;
}

export interface ChartDataItem {
  name: string;
  value: number;
  color: string;
  [key: string]: string | number;
}

export interface ChartDataSummary {
  totalValue: number;
  displayedValue: number;
  hiddenValue: number;
  totalGroups: number;
  displayedGroups: number;
  hiddenGroups: number;
  isTruncated: boolean;
  dimensionName?: string;
  measureName?: string;
}

export interface ConversationState {
  messages: Message[];
  isStreaming: boolean;
  selectedSources: DataSourceType[];
  isReasoning: boolean;
  query: string;
}

export type ReportChartType = 'bar' | 'pie' | 'donut' | 'line' | 'stackedBar' | 'table';

export interface SmartReportMetric {
  label: string;
  value: string | number;
  description?: string;
}

export interface SmartReportStep {
  id: string;
  title: string;
  description: string;
  status: 'completed' | 'running' | 'pending';
}

export interface SmartReportChart {
  id: string;
  title: string;
  subtitle?: string;
  type: ReportChartType;
  dimension: string;
  measures: string[];
  data: Array<Record<string, string | number>>;
  summary?: ChartDataSummary;
}

export interface SmartReportTable {
  id: string;
  title: string;
  columns: string[];
  rows: Array<Record<string, string | number>>;
}

export interface SmartReportRootCause {
  keyword: string;
  count: number;
  ratio: number;
  evidence: string[];
}

export interface SmartReportSection {
  heading: string;
  narrative: string;
  insights?: string[];
  chartIds?: string[];
  tableIds?: string[];
}

export interface SmartReportTimeRange {
  label?: string;
  field?: string;
  start?: string;
  end?: string;
}

export interface SmartReportChartExplanation {
  chartId: string;
  title: string;
  explanation: string;
}

export interface SmartReportAnalysisGroup {
  title: string;
  points: string[];
}

export interface SmartReportFinalSummary {
  summary: string;
  analysisGroups?: SmartReportAnalysisGroup[];
  positives: string[];
  risks: string[];
  actions: string[];
}

export interface SmartReport {
  title: string;
  subtitle?: string;
  generatedAt: string;
  recordCount: number;
  timeRange?: SmartReportTimeRange;
  classification: {
    intent: 'report';
    reason: string;
  };
  dataSources: string[];
  metrics: SmartReportMetric[];
  steps: SmartReportStep[];
  executiveSummary: string;
  sections: SmartReportSection[];
  chartExplanations: SmartReportChartExplanation[];
  charts: SmartReportChart[];
  tables: SmartReportTable[];
  rootCauses: SmartReportRootCause[];
  recommendations: string[];
  finalSummary: SmartReportFinalSummary;
}

export const SUGGESTION_QUERIES = [
  { label: '分析上月负面异常问题', variant: 'mint' as const },
  { label: '生成本周产品分析周报', variant: 'purple' as const },
  { label: '查看用户关注场景分布', variant: 'blue' as const },
];

export const FOLLOW_UP_VARIANTS = ['mint', 'purple', 'blue'] as const;
