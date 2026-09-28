import { Suspense } from "react";
import { IssuerConsole } from "./console";

export default function IssuerPage() {
  return (
    <Suspense>
      <IssuerConsole />
    </Suspense>
  );
}
