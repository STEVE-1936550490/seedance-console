import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./styles.css";

export const metadata: Metadata = {
  title: "Seedance Console",
  description: "Internal AI video infrastructure console"
};

export default function RootLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="appShell">
          <header className="topbar">
            <Link className="brand" href="/">
              <span className="brandMark">S</span>
              <span>
                <strong>Seedance Console</strong>
                <small>Internal Studio</small>
              </span>
            </Link>
            <nav aria-label="主导航">
              <Link href="/">创作台</Link>
              <Link href="/history">任务历史</Link>
            </nav>
            <div className="environmentBadge">
              <span />
              Mock 环境
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
