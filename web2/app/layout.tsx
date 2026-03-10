import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";
import CustomCursor from "./components/CustomCursor";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Landin - Premium Agency for Creatives",
  description: "Premium Agency for Creatives. We specialize in crafting unique digital presence.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${dmSans.variable} antialiased`}>
        <CustomCursor />
        {children}
      </body>
    </html>
  );
}
