import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: "TinyClaw Mission Control",
  description: "Multi-agent orchestration dashboard for TinyClaw",
};

// Inline script to apply theme before paint — prevents flash of wrong theme
const themeScript = `(function(){
  try{
    var t=localStorage.getItem('tc-theme')||'zinc';
    var m=localStorage.getItem('tc-mode')||'dark';
    document.documentElement.setAttribute('data-theme',t);
    if(m==='dark')document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }catch(e){}
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            <main className="flex-1 overflow-y-auto">
              {children}
            </main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
