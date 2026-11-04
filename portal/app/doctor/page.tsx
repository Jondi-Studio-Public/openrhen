"use client";

import { DoctorPage } from "@/features/doctor/components/doctor-page";

/** `/doctor`: the data check. Opened from You, or from the count on Review. */
export default function DoctorRoute() {
  return (
    <main className="content-page">
      <h1>Data check</h1>
      <p className="reason">What in your plan is out of date or missing.</p>
      <DoctorPage />
    </main>
  );
}
