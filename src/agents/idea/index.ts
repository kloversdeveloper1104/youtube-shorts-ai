// IdeaAgent: 毎日最低10個のオリジナル企画候補を生成する(仕様書 12節)
// バズ動画の「構造」のみを参考にし、テーマ・タイトル・台本は完全に別物へ変換する(仕様書 11, 47節)

import { SchemaType } from "@google/generative-ai";
import { generateJson } from "@/gemini/client";
import { prisma } from "@/database/client";
import { logError } from "@/utils/logger";
import { computeIdeaTotalScore, type IdeaScoreBreakdown } from "./scoring";
import { getRecentTrendingTopics } from "@/agents/trend";

interface RawIdea {
  title: string;
  genre: string;
  target_audience: string;
  hook: string;
  summary: string;
  production_difficulty: "低" | "中" | "高";
  expected_retention: number;
  score_breakdown: {
    target_fit: number;
    hook: number;
    novelty: number;
    information_value: number;
    comment_potential: number;
    visual_potential: number;
    originality: number;
  };
}

const IDEAS_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    ideas: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING },
          genre: { type: SchemaType.STRING },
          target_audience: { type: SchemaType.STRING },
          hook: { type: SchemaType.STRING },
          summary: { type: SchemaType.STRING },
          production_difficulty: { type: SchemaType.STRING },
          expected_retention: { type: SchemaType.NUMBER },
          score_breakdown: {
            type: SchemaType.OBJECT,
            properties: {
              target_fit: { type: SchemaType.NUMBER },
              hook: { type: SchemaType.NUMBER },
              novelty: { type: SchemaType.NUMBER },
              information_value: { type: SchemaType.NUMBER },
              comment_potential: { type: SchemaType.NUMBER },
              visual_potential: { type: SchemaType.NUMBER },
              originality: { type: SchemaType.NUMBER },
            },
            required: ["target_fit", "hook", "novelty", "information_value", "comment_potential", "visual_potential", "originality"],
          },
        },
        required: ["title", "genre", "target_audience", "hook", "summary", "production_difficulty", "expected_retention", "score_breakdown"],
      },
    },
  },
  required: ["ideas"],
};

const SYSTEM_INSTRUCTION = `あなたはYouTube Shortsチャンネルの企画プロデューサーです。
ターゲットは「日本人30代男性(会社員、スマホでスキマ時間にShortsを見る)」です。
絶対的なルール:
- 参考にする「構造」から、必ず別のテーマ・別の切り口の企画へ変換すること(コピー厳禁)
- 各企画は0-100のスコアを score_breakdown の各項目に付けること
- 誇大・虚偽・危険な内容は生成しないこと
- titleとhookは、summaryで説明する実際の内容から誇張・逸脱しないこと。
  「実質無料」「悪用厳禁」「裏技」等の強い言葉を使う場合は、内容が本当にその言葉に見合う
  具体性・意外性を持っていることを必ず確認すること(内容が伴わない釣りタイトルは禁止)
- 出力は日本語`;

export interface GeneratedIdea {
  id: string;
  title: string;
  scoreTotal: number;
}

export async function generateDailyIdeas(count = 10): Promise<GeneratedIdea[]> {
  const recentAnalyses = await prisma.videoAnalysis.findMany({
    orderBy: { analyzedAt: "desc" },
    take: 8,
  });

  const recentStrategy = await prisma.strategy.findFirst({
    orderBy: { generatedAt: "desc" },
  });

  const structureHints = recentAnalyses
    .map(
      (a) =>
        `- テーマ:${a.topic} / フック種別:${a.hookType} / 構成:${a.structure} / なぜ伸びた:${a.whyItWorks}`
    )
    .join("\n");

  const strategyHints = recentStrategy
    ? `過去の勝ちパターン: ${recentStrategy.winningPatterns}\n避けるべきパターン: ${recentStrategy.losingPatterns}\nベストな尺: ${recentStrategy.bestLength}\nベストなフック: ${recentStrategy.bestHooks}`
    : "まだ十分なデータが蓄積されていません。初期カテゴリから幅広く企画してください。";

  const trendingTopics = await getRecentTrendingTopics(15);
  const trendingHints = trendingTopics.length > 0
    ? trendingTopics.map((t) => `- ${t.title}(Buzz:${t.buzzScore ?? 0})`).join("\n")
    : "(直近の急上昇データがまだありません。「トレンド」ページから収集を実行してください。)";

  const initialCategories = [
    "知らないと損する雑学", "30代男性向け雑学", "仕事", "お金", "節約", "AI", "心理学",
    "科学", "生活", "日本の雑学", "昔と今", "懐かしいもの", "商品の秘密", "身近な疑問",
    "ランキング", "比較", "意外な事実",
  ];

  const prompt = `以下を踏まえて、YouTube Shorts用のオリジナル企画を${count}個生成してください。

【直近48時間の急上昇テーマ(タイトルからキーワード・話題性のみ参考にし、内容は絶対にコピーしない)】
${trendingHints}

【参考にする構造(コピー禁止・構造のみ抽出)】
${structureHints || "(まだ分析データがありません)"}

【このチャンネルの学習結果】
${strategyHints}

【初期カテゴリ候補】
${initialCategories.join(" / ")}

企画の一部(3〜5個)は、上記の急上昇テーマで使われているキーワードや話題の切り口を、
30代男性向けに翻案したものにしてください。ただし文章・タイトル・構成の丸写しは厳禁です。
残りは通常通り幅広いカテゴリから発想してください。
各企画には score_breakdown (0-100) を必ず付けてください。`;

  try {
    const { ideas } = await generateJson<{ ideas: RawIdea[] }>(prompt, IDEAS_SCHEMA, {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 1.0,
    });

    const created: GeneratedIdea[] = [];
    for (const raw of ideas) {
      const breakdown: IdeaScoreBreakdown = {
        targetFit: raw.score_breakdown.target_fit,
        hook: raw.score_breakdown.hook,
        novelty: raw.score_breakdown.novelty,
        informationValue: raw.score_breakdown.information_value,
        commentPotential: raw.score_breakdown.comment_potential,
        visualPotential: raw.score_breakdown.visual_potential,
        originality: raw.score_breakdown.originality,
      };
      const scoreTotal = computeIdeaTotalScore(breakdown);
      const status = scoreTotal < 70 ? "REJECTED" : "PENDING";

      const idea = await prisma.idea.create({
        data: {
          title: raw.title,
          genre: raw.genre,
          targetAudience: raw.target_audience,
          hook: raw.hook,
          summary: raw.summary,
          buzzScore: null,
          originalityScore: breakdown.originality,
          productionDifficulty: raw.production_difficulty,
          expectedRetention: raw.expected_retention,
          scoreTotal,
          scoreBreakdown: JSON.stringify(breakdown),
          status,
          sourceAnalysisIds: JSON.stringify(recentAnalyses.map((a) => a.id)),
        },
      });

      created.push({ id: idea.id, title: idea.title, scoreTotal });
    }

    return created;
  } catch (err) {
    await logError("IdeaAgent", err, { count });
    return [];
  }
}

export async function getTopPendingIdeas(limit = 10) {
  return prisma.idea.findMany({
    where: { status: "PENDING" },
    orderBy: { scoreTotal: "desc" },
    take: limit,
  });
}
