import { NextRequest, NextResponse } from 'next/server';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_FLASH_MODEL = 'deepseek-v4-flash';

const serverCache = new Map<string, string>();

export async function POST(request: NextRequest) {
  try {
    const { chars } = await request.json() as { chars: string[] };
    if (!Array.isArray(chars) || chars.length === 0) {
      return NextResponse.json({ success: false, error: 'chars 参数为空' });
    }

    const uncached = chars.filter((c) => !serverCache.has(c));
    if (uncached.length > 0) {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) {
        return NextResponse.json({ success: false, error: '未配置 DEEPSEEK_API_KEY' });
      }

      const prompt = `你是一个中文拼音专家。请返回以下中文字符的拼音首字母（大写英文字母）。
规则：
- 只返回 JSON 对象，键为原字符，值为大写拼音首字母
- 不要有任何其他文字说明
- 如果字符不是中文，直接返回该字符的大写形式

字符列表：${uncached.join('')}

示例输出格式：{"赵":"Z","钱":"Q","A":"A"}`;

      const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: DEEPSEEK_FLASH_MODEL,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          temperature: 0,
          max_tokens: 256,
        }),
      });

      if (!response.ok) {
        return NextResponse.json({ success: false, error: `DeepSeek API 错误: ${response.status}` });
      }

      const json = await response.json();
      const content = json.choices?.[0]?.message?.content || '';

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, string>;
        for (const [char, initial] of Object.entries(parsed)) {
          serverCache.set(char, initial.toUpperCase());
        }
      }
    }

    const result: Record<string, string> = {};
    for (const c of chars) {
      result[c] = serverCache.get(c) || c.toUpperCase();
    }

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : '拼音首字母查询失败';
    return NextResponse.json({ success: false, error: message });
  }
}
