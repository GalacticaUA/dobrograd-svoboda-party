import type { Metadata, Viewport } from "next";
import { DM_Sans, Space_Grotesk } from "next/font/google";
import { Suspense } from "react";
import { AuthButton } from "@/components/auth/auth-button";
import { AuthNotice } from "@/components/auth/auth-notice";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { Toaster } from "@/components/ui/sonner";
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
        {/* AuthButton is a server component that reads the session cookie; it is
            passed in as a slot so the client-side header can render it. This
            makes the root layout dynamic, which is the cost of server-read auth
            state in the navigation. */}
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
      </body>
    </html>
  );
}
