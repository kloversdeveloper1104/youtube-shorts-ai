// 常駐スケジューラー(仕様書 36節)
// 06:00 Trend収集 / 07:00 Viral分析 / 08:00 Idea生成
// 投稿サイクルは約60分間隔(±15分のランダムジッター)で実行し、
// 1日の投稿数がmaxPostsPerDayに達したらその日はスキップする / 23:30 戦略分析 / 随時 Analytics測定

import "dotenv/config";
import { prisma } from "@/database/client";
import { collectTrends, collectTrendingChart } from "@/agents/trend";
import { analyzeUnanalyzedVideos } from "@/agents/viral";
import { generateDailyIdeas } from "@/agents/idea";
import { runAutoCycle } from "./pipeline";
import { measureAndEvaluate } from "@/agents/analytics";
import { updateStrategy } from "@/agents/strategy";
import { getAutoMode } from "@/utils/env";
import { logError } from "@/utils/logger";

const FIXED_SCHEDULE: Array<{ hour: number; minute: number; task: string }> = [
  { hour: 6, minute: 0, task: "TREND" },
  { hour: 7, minute: 0, task: "VIRAL" },
  { hour: 8, minute: 0, task: "IDEA" },
  { hour: 23, minute: 30, task: "STRATEGY" },
];

const CYCLE_INTERVAL_BASE_MIN = 60;
const CYCLE_INTERVAL_JITTER_MIN = 15;

/** 次回CYCLE実行時刻を、約60分±15分のランダム間隔で決める */
function scheduleNextCycle(from: Date): Date {
  const jitter = (Math.random() * 2 - 1) * CYCLE_INTERVAL_JITTER_MIN; // -15〜+15分
  const minutes = CYCLE_INTERVAL_BASE_MIN + jitter;
  return new Date(from.getTime() + minutes * 60 * 1000);
}

let nextCycleAt: Date | null = null;

const ANALYTICS_WINDOWS: Array<{ label: "24h" | "48h" | "72h" | "7d"; hours: number }> = [
  { label: "24h", hours: 24 },
  { label: "48h", hours: 48 },
  { label: "72h", hours: 72 },
  { label: "7d", hours: 24 * 7 },
];

const ranToday = new Set<string>();

async function runTask(task: string) {
  console.log(`[Worker] ${new Date().toISOString()} タスク実行: ${task}`);
  try {
    const channel = (await prisma.channel.findFirst()) ?? (await prisma.channel.create({
      data: { googleAccountEmail: "kloversmovie@gmail.com" },
    }));

    switch (task) {
      case "TREND":
        await collectTrends();
        await collectTrendingChart();
        break;
      case "VIRAL":
        await analyzeUnanalyzedVideos(10);
        break;
      case "IDEA":
        await generateDailyIdeas(10);
        break;
      case "CYCLE": {
        const mode = channel.autoMode !== "OFF" ? channel.autoMode : getAutoMode();
        if (mode === "OFF") break;

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todaysUploads = await prisma.upload.count({
          where: { status: "UPLOADED", publishedAt: { gte: todayStart } },
        });
        if (todaysUploads >= channel.maxPostsPerDay) {
          console.log(`[Worker] 本日の投稿上限(${channel.maxPostsPerDay}件)に達しているためCYCLEをスキップします。`);
          break;
        }

        await runAutoCycle({ autoUpload: mode === "FULL", privacyStatus: "public" });
        break;
      }
      case "STRATEGY":
        await updateStrategy(channel.id);
        break;
    }
  } catch (err) {
    await logError("Worker", err, { task });
  }
}

async function checkAnalytics() {
  const uploads = await prisma.upload.findMany({
    where: { status: "UPLOADED", youtubeVideoId: { not: null } },
    include: { video: { include: { script: true, analytics: true } } },
  });

  for (const upload of uploads) {
    if (!upload.publishedAt) continue;
    const hoursSince = (Date.now() - upload.publishedAt.getTime()) / (1000 * 60 * 60);

    for (const window of ANALYTICS_WINDOWS) {
      if (hoursSince < window.hours) continue;
      const already = upload.video.analytics.some((a) => a.windowLabel === window.label);
      if (already) continue;

      await measureAndEvaluate(upload.video, upload.video.script, upload, window.label);
    }
  }
}

async function tick() {
  const now = new Date();
  const key = `${now.toDateString()}-${now.getHours()}-${now.getMinutes()}`;

  for (const s of FIXED_SCHEDULE) {
    if (now.getHours() === s.hour && now.getMinutes() === s.minute) {
      const taskKey = `${key}-${s.task}-${s.hour}:${s.minute}`;
      if (!ranToday.has(taskKey)) {
        ranToday.add(taskKey);
        await runTask(s.task);
      }
    }
  }

  // CYCLE(投稿)は約60分±15分のランダム間隔で実行(1日の上限はrunTask内でチェック)
  if (!nextCycleAt) nextCycleAt = scheduleNextCycle(now);
  if (now >= nextCycleAt) {
    await runTask("CYCLE");
    nextCycleAt = scheduleNextCycle(now);
  }

  // 古いキーを掃除(メモリリーク防止)
  if (ranToday.size > 1000) ranToday.clear();

  await checkAnalytics();
}

async function main() {
  console.log("YouTube Shorts AI ワーカーを起動しました。1分間隔でスケジュールを確認します。");
  await tick();
  setInterval(() => {
    tick().catch((err) => console.error("[Worker] tick error:", err));
  }, 60 * 1000);
}

main();
