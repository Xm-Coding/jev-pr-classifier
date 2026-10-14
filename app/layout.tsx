import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PR Lens · PR 分类工作台",
  description: "输入公开 PR 链接，通过 Jev 查看七类分类概率与置信度。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
