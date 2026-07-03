import BrandDetail from "./BrandDetail";

export default async function BrandPage({ params }: { params: Promise<{ id: string }> }) {
  return <BrandDetail clientId={(await params).id} />;
}
