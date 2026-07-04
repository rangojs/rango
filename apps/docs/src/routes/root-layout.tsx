import { Outlet } from "@rangojs/router/client";

import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";

export function RootLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Navbar />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
