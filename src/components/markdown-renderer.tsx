'use client';

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

interface MarkdownRendererProps {
  content: string;
  showCursor?: boolean;
}

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h2 className="mt-5 mb-2.5 text-[17px] font-extrabold tracking-tight text-[#0066CC] first:mt-0">
      {children}
    </h2>
  ),
  h2: ({ children }) => (
    <h3 className="mt-4 mb-2 text-[15px] font-extrabold text-[#0066CC]">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-3.5 mb-1.5 text-[14px] font-bold text-[#0066CC]">
      {children}
    </h4>
  ),
  p: ({ children }) => {
    return <p className="my-2 text-[14px] leading-[1.75] text-[#333333]">{children}</p>;
  },
  strong: ({ children }) => (
    <strong className="font-extrabold text-[#333333]">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="italic text-[#009999]">{children}</em>
  ),
  ul: ({ children }) => (
    <ul className="my-2.5 ml-1 space-y-1 list-none">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2.5 ml-1 space-y-1 list-none">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="flex items-start gap-2 text-[14px] leading-[1.7] text-[#333333]">
      <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#0066CC]/70" />
      <span className="flex-1 min-w-0">{children}</span>
    </li>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-[3px] border-[#0066CC]/40 bg-[#E8F0FE]/70 px-4 py-2.5 rounded-r-xl text-[13px] leading-relaxed text-[#009999] italic">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="rounded-md bg-[#E8F0FE]/80 px-1.5 py-0.5 text-[13px] font-medium text-[#0066CC]">
          {children}
        </code>
      );
    }
    return (
      <code className="block my-2.5 overflow-x-auto rounded-xl bg-[#1e293b] px-5 py-4 text-[13px] leading-[1.65] text-[#e2e8f0]">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-slate-200/80">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-[#E8F0FE]/70">{children}</thead>
  ),
  tbody: ({ children }) => <tbody className="divide-y divide-slate-100">{children}</tbody>,
  th: ({ children }) => (
    <th className="px-4 py-2.5 text-left text-[12px] font-extrabold text-[#0066CC] whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2.5 text-[#333333]">{children}</td>
  ),
  tr: ({ children }) => <tr className="even:bg-white/40">{children}</tr>,
  hr: () => <hr className="my-4 border-slate-100" />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[#0066CC] underline decoration-[#0066CC]/30 underline-offset-2 hover:decoration-[#0066CC]"
    >
      {children}
    </a>
  ),
};

export function MarkdownRenderer({ content, showCursor }: MarkdownRendererProps) {
  const stableContent = useMemo(() => content, [content]);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {stableContent}
      </ReactMarkdown>
      {showCursor && <span className="voc-typing-cursor" />}
    </div>
  );
}
