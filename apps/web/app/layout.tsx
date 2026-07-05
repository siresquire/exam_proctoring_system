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
  // Not swapping the favicon for the full AAMUSTED logo: it's a wide
  // crest+wordmark lockup, and shrinking it to a 16-32px square (browser
  // tab size) makes the wordmark illegible and the crest a smudge — cropping
  // just the crest would need real image processing (this repo's only
  // image-capable dependency, pngjs, decodes/encodes but doesn't resize or
  // crop), which is out of scope for "trivial via Next metadata icons" per
  // the task brief. Keeping the default favicon.ico.
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
