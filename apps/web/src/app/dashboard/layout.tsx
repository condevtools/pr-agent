import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  if (!session) {
    redirect("/login");
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar - hidden on mobile, visible on lg+ */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header userName={session.user.name} userEmail={session.user.email} />
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
