import { Suspense } from "react";
import { ProofView } from "./proof";

export default function ProofPage() {
  return (
    <Suspense>
      <ProofView />
    </Suspense>
  );
}
