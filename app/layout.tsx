import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Local LaTeX Workbench — AI paper workspace",
  description:
    "Write, compile, and revise LaTeX papers with your local Codex subscription.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
