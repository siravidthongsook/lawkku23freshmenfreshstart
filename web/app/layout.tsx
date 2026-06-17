import type { Metadata } from "next";
import { IBM_Plex_Sans_Thai } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";

// Self-hosted Thai/Latin font. Not a variable font -> list weights explicitly. Exposes --font-ibm-plex-sans-thai.
const ibmPlexSansThai = IBM_Plex_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  variable: "--font-ibm-plex-sans-thai",
});

export const metadata: Metadata = {
  title: "LawKKUFreshmenFreshStart23",
  description: "ระบบลงทะเบียนและเช็คอินกิจกรรมนักศึกษา",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" className={ibmPlexSansThai.variable}>
      <body className="font-sans antialiased">
        {/* Auth context + global toaster wrap the whole app. richColors gives green success / red error. */}
        <AuthProvider>{children}</AuthProvider>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
