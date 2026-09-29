import { Suspense } from "react";
import { BaseIssuerConsole } from "./console";

export default function BaseIssuerPage() {
  return (
    <Suspense>
      <BaseIssuerConsole />
    </Suspense>
  );
}
