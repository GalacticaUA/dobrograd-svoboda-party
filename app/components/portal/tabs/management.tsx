"use client";

import Link from "next/link";
import { ExternalLink, FileSpreadsheet, Inbox } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { PageTitle, Panel, StaffOnly, LoadingBlock } from "@/components/portal/primitives";
import { ApplicationReview } from "@/components/admin/application-review";
import { exportApplicationsCsv } from "@/lib/auth/actions";
import { loadApplications } from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import { downloadCsv, applicationsCsvFilename } from "@/lib/csv";
import type { ApplicationRecord, ProfileDTO } from "@/types/auth";

/**
 * Staff-only: the join queue and the export.
 *
 * The approval table is the same component the full-page `/admin` renders, reused
 * rather than duplicated. Two copies of the review logic would drift, and the
 * one that fell behind would be the one silently letting applicants through.
 *
 * `ApplicationReview` takes its rows as a prop rather than fetching them, because
 * it is a client component and the DAL is server-only. The tab loads them through
 * a staff-gated Server Action and passes them down.
 */
export function ManagementTab({ profile }: { profile: ProfileDTO }) {
  const { data, pending, error } = useAsyncData<ApplicationRecord[]>(loadApplications);

  return (
    <StaffOnly roles={profile.roles} action="application.review">
      <div className="space-y-4">
        <PageTitle
          title="Управление"
          sub="Заявки на вступление, выгрузка, полная страница админа."
          action={
            <div className="flex flex-wrap items-center gap-2">
              <ExportButton />
              <Link
                href="/admin"
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground transition hover:border-primary hover:text-cloud"
              >
                <ExternalLink className="h-4 w-4" />
                /admin
              </Link>
            </div>
          }
        />

        <Panel>
          <h3 className="mb-3 flex items-center gap-2 font-display text-base text-cloud">
            <Inbox className="h-4 w-4 text-primary" />
            Очередь заявок
          </h3>
          {pending ? (
            <LoadingBlock label="Читаем заявки…" />
          ) : error ? (
            <p className="text-sm text-muted-foreground">{error}</p>
          ) : (
            <ApplicationReview initialApplications={data ?? []} />
          )}
        </Panel>
      </div>
    </StaffOnly>
  );
}

function ExportButton() {
  const [exporting, startExport] = useTransition();

  return (
    <button
      type="button"
      disabled={exporting}
      onClick={() =>
        startExport(async () => {
          const result = await exportApplicationsCsv();
          if (result.ok) {
            downloadCsv(result.data.csv, applicationsCsvFilename());
            toast.success("Выгрузка готова");
          } else {
            toast.error(result.error);
          }
        })
      }
      className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground transition hover:border-primary hover:text-cloud disabled:opacity-60"
    >
      <FileSpreadsheet className="h-4 w-4" />
      Выгрузить заявки
    </button>
  );
}
