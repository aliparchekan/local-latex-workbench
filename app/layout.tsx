import type { Metadata } from "next";
import "@primer/primitives/dist/css/base/size/size.css";
import "@primer/primitives/dist/css/base/typography/typography.css";
import "@primer/primitives/dist/css/functional/size/border.css";
import "@primer/primitives/dist/css/functional/spacing/space.css";
import "@primer/primitives/dist/css/functional/typography/typography.css";
import "@primer/primitives/dist/css/functional/themes/light.css";
import "@primer/primitives/dist/css/functional/themes/dark.css";
import "./globals.css";
import "./workbench-themes.css"; // Slate blue light / Graphite dark semantic colors.
import "./primer-workbench.css"; // Approved three-pane workbench shell.

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
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
