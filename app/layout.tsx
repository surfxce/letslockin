import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lockin",
  description: "Lecture in, questions out, gaps on paper.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <div className="top">
            <p className="brand">
              <Link href="/">Lockin</Link>
            </p>
            <span className="crumb">retrieval practice, scored on the geometric mean</span>
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
