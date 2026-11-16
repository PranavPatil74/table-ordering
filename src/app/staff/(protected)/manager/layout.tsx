import { FeedbackProvider } from "@/components/admin/feedback";
import { ManagerNav } from "@/components/admin/manager-nav";
import { requireStaffPage } from "@/lib/auth/session";

/**
 * Manager area shell. Counter staff and signed-out visitors never see it: requireStaffPage
 * answers 404 for a role that is too low, so the section does not even reveal that it exists.
 * Every page and Server Action below checks again; this layout is not the security boundary.
 */
export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  await requireStaffPage("manager");
  return (
    <FeedbackProvider>
      <ManagerNav />
      <div className="flex flex-col gap-8">{children}</div>
    </FeedbackProvider>
  );
}
