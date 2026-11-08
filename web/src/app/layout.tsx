import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "transcribe-url",
  description: "Local web UI for transcribe-url",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/">transcribe-url</Link>
          <span className="muted">local · nothing leaves this machine except Interpret</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
