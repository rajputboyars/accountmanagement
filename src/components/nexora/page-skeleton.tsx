"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "./language-provider";
import { PageContainer } from "./page-container";

export function PageSkeleton() {
  const t = useT();
  return (
    <PageContainer>
      <span className="sr-only" role="status">
        {t("common.loading")}
      </span>
      <Skeleton className="h-5 w-72 max-w-full" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-36 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-2xl" />
    </PageContainer>
  );
}
