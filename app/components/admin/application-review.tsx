"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Download, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { exportApplicationsCsv, reviewApplication } from "@/lib/auth/actions";
import { steamProfileUrl } from "@/lib/auth/profile";
import { applicationsCsvFilename, downloadCsv } from "@/lib/csv";
import type { ApplicationRecord } from "@/types/auth";
import type { ApplicationStatus } from "@/types/party";

/**
 * Approval queue for membership applications.
 *
 * Receives its rows as props from a Server Component that already called
 * `requireStaff()`, so the applicant PII in this table reached the browser only
 * after an authorisation check. It is the first consumer of table.tsx.
 *
 * Each approve/reject call goes to a Server Action that re-verifies the session
 * and the live role on the server. The row returned by that action replaces the
 * one in local state, so the table updates immediately without polling - and the
 * client can never set a status the server did not confirm.
 */

const STATUS_VARIANT: Record<ApplicationStatus, "default" | "secondary" | "destructive"> = {
  approved: "default",
  pending: "secondary",
  rejected: "destructive",
};

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  approved: "Одобрена",
  pending: "На рассмотрении",
  rejected: "Отклонена",
};

const SOURCE_LABEL: Record<ApplicationRecord["source"], string> = {
  native: "Сайт",
  google: "Google Форма",
};

export function ApplicationReview({ initialApplications }: { initialApplications: ApplicationRecord[] }) {
  const router = useRouter();
  const [applications, setApplications] = useState(initialApplications);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const pendingCount = applications.filter((a) => a.status === "pending").length;

  function review(id: string, status: "approved" | "rejected") {
    // The 24-hour check runs inside the Server Action, before the database is
    // touched. This local disable only prevents double-clicks.
    setBusyId(id);

    startTransition(async () => {
      const result = await reviewApplication(id, status);

      setBusyId(null);

      if (!result.ok) {
        toast.error(result.error);
        // A session failure means the cookie has just been wiped server-side.
        // Refresh so the header button drops back to its signed-out state.
        if (result.reason) router.refresh();
        return;
      }

      setApplications((previous) =>
        previous.map((item) => (item.id === result.data.application.id ? result.data.application : item)),
      );
      toast.success(status === "approved" ? "Заявка одобрена" : "Заявка отклонена");
    });
  }

  function exportCsv() {
    startTransition(async () => {
      const result = await exportApplicationsCsv();

      if (!result.ok) {
        toast.error(result.error);
        if (result.reason) router.refresh();
        return;
      }

      downloadCsv(result.data.csv, applicationsCsvFilename());
      toast.success(`Выгружено заявок: ${applications.length}`);
    });
  }

  if (applications.length === 0) {
    return (
      <p className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        Заявок пока нет.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Всего: <span className="text-cloud">{applications.length}</span> · на рассмотрении:{" "}
          <span className="text-amber-400">{pendingCount}</span>
        </p>

        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-2 text-sm text-cloud transition hover:border-primary/50 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Download className="h-4 w-4" aria-hidden />
          Экспорт в CSV
        </button>
      </div>

      <div className="rounded-2xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ФИО</TableHead>
              <TableHead>Район</TableHead>
              <TableHead>Контакты</TableHead>
              <TableHead>Steam</TableHead>
              <TableHead>Мотивация</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead>Действия</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {applications.map((application) => {
              const busy = busyId === application.id;
              const settled = application.status !== "pending";

              return (
                <TableRow key={application.id} className={settled ? "opacity-60" : undefined}>
                  <TableCell className="font-medium text-cloud">
                    {application.name}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {SOURCE_LABEL[application.source]} · {application.submittedAt}
                    </span>
                  </TableCell>

                  <TableCell className="whitespace-nowrap">{application.district}</TableCell>

                  <TableCell>
                    <div className="space-y-0.5 text-sm">
                      {application.phone ? (
                        <a
                          href={`tel:${application.phone.replace(/[^\d+]/g, "")}`}
                          className="block hover:text-primary"
                        >
                          {application.phone}
                        </a>
                      ) : null}
                      {application.email ? (
                        <a href={`mailto:${application.email}`} className="block hover:text-primary">
                          {application.email}
                        </a>
                      ) : null}
                      {application.discord ? (
                        <span className="text-muted-foreground">Discord: {application.discord}</span>
                      ) : null}
                    </div>
                  </TableCell>

                  <TableCell>
                    {application.steam ? (
                      <a
                        href={steamProfileUrl(application.steam)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                      >
                        {application.steam}
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>

                  <TableCell className="max-w-sm">
                    <p className="line-clamp-3 text-sm text-muted-foreground">
                      {application.motivation || "-"}
                    </p>
                  </TableCell>

                  <TableCell>
                    <Badge variant={STATUS_VARIANT[application.status]}>
                      {STATUS_LABEL[application.status]}
                    </Badge>
                  </TableCell>

                  <TableCell>
                    {settled ? (
                      <span className="text-xs text-muted-foreground">Решено</span>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => review(application.id, "approved")}
                          disabled={busy}
                          className="inline-flex items-center gap-1 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs text-cloud transition hover:border-emerald-400/60 hover:bg-card disabled:opacity-50"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden />
                          Одобрить
                        </button>
                        <button
                          type="button"
                          onClick={() => review(application.id, "rejected")}
                          disabled={busy}
                          className="inline-flex items-center gap-1 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs text-cloud transition hover:border-destructive/60 hover:bg-card disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                          Отклонить
                        </button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
