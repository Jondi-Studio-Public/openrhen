import { CommitmentDetail } from "@/features/commitments/components/commitment-detail";

/**
 * One commitment's own address. The page is deliberately nothing but the id: everything it shows is
 * read from portal state in the browser, like every other page here, and the sections live in
 * `features/commitments/` so a later move of this route carries no UI with it.
 */
export default async function CommitmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CommitmentDetail commitmentId={id} />;
}
