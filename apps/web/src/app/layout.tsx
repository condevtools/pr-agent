import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-local.woff2",
  variable: "--font-jetbrains-mono",
  display: "swap",
});

const ibmPlexMono = localFont({
  src: "./fonts/ibm-plex-mono-local.woff2",
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MR Agent — AI Code Review Dashboard",
  description: "Configure your AI-powered code review bot",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${jetbrainsMono.variable} ${ibmPlexMono.variable} min-h-screen antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
