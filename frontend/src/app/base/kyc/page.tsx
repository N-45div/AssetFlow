import { Suspense } from "react";
import { BaseKycProvider } from "./provider";

export default function BaseKycPage() {
  return (
    <Suspense>
      <BaseKycProvider />
    </Suspense>
  );
}
