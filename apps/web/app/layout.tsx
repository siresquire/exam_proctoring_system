import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import { AxeInit } from "@/components/dev/axe-init";
import { FontSizeScript } from "@/components/layout/font-size-script";
import { SkipLink } from "@/components/layout/skip-link";
import { SiteHeader } from "@/components/layout/site-header";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "USTED Exam Proctoring",
  description: "Exam proctoring and anti-cheat platform for USTED.",
  // Favicon + Apple icon: the USTED crest (just the emblem, no wordmark —
  // a manually-cropped square version of the logo) lives at
  // app/icon.png and app/apple-icon.png, which Next auto-detects and links.
  // The crest reads clearly at tab size; the full crest+wordmark lockup
  // (public/aamusted-logo.png) is still used in the header where there's room.
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground flex min-h-full flex-col">
        <FontSizeScript />
        <ThemeProvider>
          <TooltipProvider>
            <AxeInit />
            <SkipLink />
            <SiteHeader />
            <main id="main-content" className="flex-1">
              {children}
            </main>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
