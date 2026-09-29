import type { Metadata, Viewport } from "next";
import { DM_Sans, Space_Grotesk } from "next/font/google";
import { Suspense } from "react";
import { AuthButton } from "@/components/auth/auth-button";
import { AuthNotice } from "@/components/auth/auth-notice";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { Toaster } from "@/components/ui/sonner";
import { RolesProvider } from "@/components/roles/roles-store";
import { missingAuthEnv } from "@/lib/env";
import { SITE_NAME } from "@/data/content";
import "./globals.css";

const fontSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

const fontDisplay = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: `${SITE_NAME} - Доброград`,
    template: `%s · ${SITE_NAME}`,
  },
  description:
    "Либерально-демократическая партия «Свобода» - гражданское движение жителей Доброграда.",
  openGraph: {
    locale: "ru_RU",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0B1017",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ru"
      className={`${fontSans.variable} ${fontDisplay.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        {/* The one place a person's roles live in the browser, wrapping the header
            as well as the page. It has to: the two surfaces that show roles are in
            different subtrees — the admin panel's people table is `children`, and
            the portal dialog hangs off the header button — so sharing state between
            them needs a shared parent, and this is the only one. A change made in
            the role editor has to be visible in the people table and in the portal
            registry without a reload. */}
        <RolesProvider>
          <SiteHeader authSlot={<AuthButton />} />
          <main className="flex-1 pt-18">{children}</main>
          <SiteFooter />

          {/* Turns ?auth=failed&reason=... into a readable toast, naming the exact
              variables to fill in when the deployment is unconfigured. Rendered
              inside Suspense because it reads searchParams. */}
          <Suspense fallback={null}>
            <AuthNotice missing={missingAuthEnv()} />
          </Suspense>

          {/* Single Toaster for the whole app, so every notification - auth
              results, admin actions, CSV export - appears in the same
              bottom-right corner. Individual toast() calls must not pass a
              `position`, or they would escape this. */}
          <Toaster position="bottom-right" richColors closeButton />
        </RolesProvider>
      </body>
    </html>
  );
}
