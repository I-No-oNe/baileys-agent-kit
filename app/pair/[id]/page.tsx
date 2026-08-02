import { PairingView } from "./pairing-view";

export default async function PairingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PairingView id={id} />;
}
