import { prisma } from "@/database/client";
import { PageHeader, Card, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LogsPage() {
  const logs = await prisma.errorLog.findMany({ orderBy: { createdAt: "desc" }, take: 50 });

  return (
    <div>
      <PageHeader title="ログ" description="エラーログ一覧(最新50件)" />
      <Card>
        {logs.length === 0 ? (
          <p className="text-sm text-slate-500">エラーはありません。</p>
        ) : (
          <div className="space-y-2">
            {logs.map((l) => (
              <div key={l.id} className="border-b border-slate-800 pb-2 text-sm">
                <div className="flex items-center justify-between">
                  <Badge color="red">{l.source}</Badge>
                  <span className="text-xs text-slate-500">{l.createdAt.toLocaleString("ja-JP")}</span>
                </div>
                <div className="text-slate-300 mt-1">{l.message}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
