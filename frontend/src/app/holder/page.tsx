import { Suspense } from "react";
import { HolderPortal } from "./portal";

export default function HolderPage() {
  return (
    <Suspense>
      <HolderPortal />
    </Suspense>
  );
}
