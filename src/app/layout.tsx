import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/shell/AppShell";
import { MaterialProvider, ShellUiProvider } from "@/lib/providers";
import { FeedbackProvider } from "@/lib/feedback";
import { ComposerProvider } from "@/lib/composer";
import { QueryProvider } from "@/lib/query";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AI Longevity Pro — Clinical Intelligence",
  description:
    "Desktop-first practitioner platform combining patient health intelligence, practice operations and a clinical AI layer.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <MaterialProvider>
          <QueryProvider>
          <ShellUiProvider>
            <FeedbackProvider>
              <ComposerProvider>
                <a
                  href="#main-content"
                  className="sr-only rounded-md bg-action px-3 py-2 text-[13px] font-semibold text-white focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[300]"
                >
                  Skip to content
                </a>
                <AppShell>{children}</AppShell>
              </ComposerProvider>
            </FeedbackProvider>
          </ShellUiProvider>
          </QueryProvider>
        </MaterialProvider>
      </body>
    </html>
  );
}
