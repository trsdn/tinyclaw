"use client";

import { useTheme, type Theme, type Mode } from "./theme-provider";
import { Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const THEMES: { id: Theme; label: string; desc: string; preview: { bg: string; card: string; accent: string } }[] = [
  {
    id: "zinc", label: "Zinc", desc: "Cool neutral",
    preview: { bg: "#09090b", card: "#131316", accent: "#a1a1aa" },
  },
  {
    id: "stone", label: "Stone", desc: "Warm neutral",
    preview: { bg: "#0c0a09", card: "#171412", accent: "#a8a29e" },
  },
  {
    id: "slate", label: "Slate", desc: "Blue-gray",
    preview: { bg: "#020617", card: "#0c1425", accent: "#94a3b8" },
  },
  {
    id: "sage", label: "Sage", desc: "Green-gray",
    preview: { bg: "#090c09", card: "#111811", accent: "#8aad8c" },
  },
  {
    id: "dusk", label: "Dusk", desc: "Mauve",
    preview: { bg: "#0a080c", card: "#14101a", accent: "#a898b4" },
  },
];

const LIGHT_PREVIEWS: Record<Theme, { bg: string; card: string; accent: string }> = {
  zinc:  { bg: "#fafafa", card: "#ffffff", accent: "#52525b" },
  stone: { bg: "#fafaf9", card: "#ffffff", accent: "#57534e" },
  slate: { bg: "#f8fafc", card: "#ffffff", accent: "#475569" },
  sage:  { bg: "#f7f9f7", card: "#ffffff", accent: "#5c7c5e" },
  dusk:  { bg: "#f9f7fa", card: "#ffffff", accent: "#7c6c8a" },
};

export function ThemeSettings() {
  const { theme, mode, setTheme, setMode } = useTheme();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Appearance</CardTitle>
        <CardDescription>Customize the look and feel of the dashboard.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Mode */}
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Mode</span>
          <div className="flex gap-2">
            {([
              { id: "light" as Mode, label: "Light", icon: Sun },
              { id: "dark" as Mode, label: "Dark", icon: Moon },
            ]).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setMode(id)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 text-sm border transition-colors",
                  mode === id
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-primary/30"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Theme */}
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Theme</span>
          <div className="grid grid-cols-5 gap-3">
            {THEMES.map((t) => {
              const p = mode === "dark" ? t.preview : LIGHT_PREVIEWS[t.id];
              const active = theme === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTheme(t.id)}
                  className={cn(
                    "group border p-3 text-left transition-all",
                    active
                      ? "border-primary ring-1 ring-primary/30"
                      : "border-border hover:border-primary/40"
                  )}
                >
                  {/* Mini preview */}
                  <div
                    className="h-16 mb-2 border border-border/50 overflow-hidden"
                    style={{ background: p.bg }}
                  >
                    <div className="flex h-full">
                      {/* Mini sidebar */}
                      <div className="w-6 h-full border-r" style={{ background: p.card, borderColor: `${p.accent}22` }}>
                        <div className="w-2 h-2 mt-1.5 mx-auto" style={{ background: p.accent }} />
                        <div className="space-y-1 mt-2 px-1">
                          <div className="h-0.5 rounded-full" style={{ background: `${p.accent}40` }} />
                          <div className="h-0.5 rounded-full" style={{ background: `${p.accent}25` }} />
                          <div className="h-0.5 rounded-full" style={{ background: `${p.accent}25` }} />
                        </div>
                      </div>
                      {/* Mini content */}
                      <div className="flex-1 p-1.5 space-y-1">
                        <div className="h-1 w-8 rounded-full" style={{ background: `${p.accent}50` }} />
                        <div className="h-4 border" style={{ background: p.card, borderColor: `${p.accent}18` }} />
                        <div className="h-1.5 w-6 rounded-full" style={{ background: p.accent }} />
                      </div>
                    </div>
                  </div>
                  <p className="text-xs font-medium">{t.label}</p>
                  <p className="text-[10px] text-muted-foreground">{t.desc}</p>
                </button>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
