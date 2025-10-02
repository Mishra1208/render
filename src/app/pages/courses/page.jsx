import { Suspense } from "react";
import CoursesClient from "./CoursesClient";

export const dynamic = "force-dynamic"; // prevents static prerendering on build

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CoursesClient />
    </Suspense>
  );
}
