import { Suspense } from "react";
import { KycProvider } from "./provider";

export default function KycPage() {
  return (
    <Suspense>
      <KycProvider />
    </Suspense>
  );
}
