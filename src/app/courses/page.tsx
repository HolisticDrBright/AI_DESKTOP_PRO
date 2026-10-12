import type { Metadata } from "next";
import { LearnerCourses } from "@/components/learner/LearnerCourses";

/**
 * My courses: a learner's own purchased courses. The page itself carries nothing private: it is a
 * shell that reads through `/api/my-courses`, where the learner host verifies who is asking.
 * It is never indexed, and it is not the public program page (`/learn/<slug>`), the practitioner
 * Studio, or the mock education preview.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My courses — The Holistic Approach", robots: { index: false, follow: false } };

export default function CoursesRoute() {
  return <LearnerCourses />;
}
