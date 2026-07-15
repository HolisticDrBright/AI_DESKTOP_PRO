import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/shell/AppShell";
import { MaterialProvider, ShellUiProvider } from "@/lib/providers";

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
          <ShellUiProvider>
            <AppShell>{children}</AppShell>
          </ShellUiProvider>
        </MaterialProvider>
      </body>
    </html>
  );
}
