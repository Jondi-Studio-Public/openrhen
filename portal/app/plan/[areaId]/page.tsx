import { AreaDetail } from "@/features/plan/components/area-detail";

/**
 * One area's own address, including the reserved `unassigned` id for projects nothing else claims.
 * Like every other route here, the page is nothing but the id: everything it shows is read from
 * portal state in the browser, in `features/plan/components/area-detail.tsx`.
 */
export default async function AreaPage({ params }: { params: Promise<{ areaId: string }> }) {
  const { areaId } = await params;
  return <AreaDetail areaId={areaId} />;
}
