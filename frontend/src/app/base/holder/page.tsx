import { Suspense } from "react";
import { BaseHolderPortal } from "./portal";

export default function BaseHolderPage() {
  return (
    <Suspense>
      <BaseHolderPortal />
    </Suspense>
  );
}
