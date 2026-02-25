"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getSettings, updateSettings, type Settings } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Settings as SettingsIcon,
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FolderOpen,
  Cpu,
  Wifi,
  Shield,
  Activity,
  Download,
  Upload,
  Code,
  Eye,
  EyeOff,
} from "lucide-react";
import { ThemeSettings } from "@/components/theme-selector";

const CHANNELS = ["discord", "telegram", "whatsapp"] as const;
const PROVIDERS = ["copilot", "copilot-sdk", "anthropic", "openai", "opencode"] as const;

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [showRawJson, setShowRawJson] = useState(false);
  const [rawJson, setRawJson] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setSettings(s);
      })
      .catch((err) => {
        setErrorMsg(err.message);
        setStatus("error");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (settings) {
      setRawJson(JSON.stringify(settings, null, 2));
    }
  }, [settings]);

  const handleSave = useCallback(async (overrideSettings?: Settings) => {
    const toSave = overrideSettings || settings;
    if (!toSave) return;
    try {
      setSaving(true);
      const result = await updateSettings(toSave);
      setSettings(result.settings);
      setStatus("saved");
      setTimeout(() => { if (mountedRef.current) setStatus("idle"); }, 3000);
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStatus("error");
      setTimeout(() => { if (mountedRef.current) setStatus("idle"); }, 5000);
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const handleSaveRawJson = async () => {
    try {
      const parsed = JSON.parse(rawJson);
      await handleSave(parsed);
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStatus("error");
      setTimeout(() => { if (mountedRef.current) setStatus("idle"); }, 5000);
    }
  };

  const handleDownload = () => {
    if (!settings) return;
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tinyclaw-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as Settings;
        await handleSave(parsed);
      } catch (err) {
        setErrorMsg((err as Error).message);
        setStatus("error");
        setTimeout(() => { if (mountedRef.current) setStatus("idle"); }, 5000);
      }
    };
    reader.readAsText(file);
    // Reset input so re-uploading same file triggers change
    e.target.value = "";
  };

  // Helpers for nested updates
  const patch = (fn: (s: Settings) => void) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const cloned = structuredClone(prev);
      fn(cloned);
      return cloned;
    });
  };

  return (
    <div className="p-8 space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <SettingsIcon className="h-5 w-5 text-primary" />
            Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            TinyClaw configuration
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status === "saved" && (
            <span className="flex items-center gap-1.5 text-sm text-emerald-500">
              <CheckCircle2 className="h-4 w-4" />
              Saved
            </span>
          )}
          {status === "error" && (
            <span className="flex items-center gap-1.5 text-sm text-destructive max-w-xs truncate">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {errorMsg}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={handleDownload} disabled={!settings}>
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            Import
          </Button>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleUpload} />
          <Button size="sm" onClick={() => handleSave()} disabled={saving || loading || !settings}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-3 w-3 animate-spin border-2 border-primary border-t-transparent" />
          Loading settings...
        </div>
      ) : settings ? (
        <>
          {/* Appearance */}
          <ThemeSettings />

          {/* Workspace */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-muted-foreground" />
                Workspace
              </CardTitle>
              <CardDescription>Base directory for agent workspaces and project files.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Name">
                <Input
                  value={settings.workspace?.name || ""}
                  onChange={(e) => patch((s) => { s.workspace = { ...s.workspace, name: e.target.value || undefined }; })}
                  placeholder="My Workspace"
                />
              </Field>
              <Field label="Path">
                <Input
                  value={settings.workspace?.path || ""}
                  onChange={(e) => patch((s) => { s.workspace = { ...s.workspace, path: e.target.value || undefined }; })}
                  placeholder="~/tinyclaw-workspace"
                  className="font-mono text-xs"
                />
              </Field>
            </CardContent>
          </Card>

          {/* Default Model */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                Default Model
              </CardTitle>
              <CardDescription>
                Fallback provider and model when agents don't specify their own. Agents override these per-agent.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Provider">
                <Select
                  value={settings.models?.provider || ""}
                  onChange={(e) => patch((s) => {
                    s.models = { ...s.models, provider: e.target.value || undefined };
                  })}
                >
                  <option value="">Select provider...</option>
                  {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
              </Field>
              {settings.models?.provider === "anthropic" && (
                <Field label="Model" hint="sonnet, opus, or full model ID">
                  <Input
                    value={settings.models?.anthropic?.model || ""}
                    onChange={(e) => patch((s) => {
                      s.models = { ...s.models, anthropic: { model: e.target.value || undefined } };
                    })}
                    placeholder="sonnet"
                    className="font-mono text-xs"
                  />
                </Field>
              )}
              {settings.models?.provider === "openai" && (
                <Field label="Model" hint="gpt-5.3-codex, gpt-4.1, etc.">
                  <Input
                    value={settings.models?.openai?.model || ""}
                    onChange={(e) => patch((s) => {
                      s.models = { ...s.models, openai: { model: e.target.value || undefined } };
                    })}
                    placeholder="gpt-5.3-codex"
                    className="font-mono text-xs"
                  />
                </Field>
              )}
              {settings.models?.provider === "opencode" && (
                <Field label="Model" hint="provider/model format">
                  <Input
                    value={settings.models?.opencode?.model || ""}
                    onChange={(e) => patch((s) => {
                      s.models = { ...s.models, opencode: { model: e.target.value || undefined } };
                    })}
                    placeholder="anthropic/claude-sonnet-4-5"
                    className="font-mono text-xs"
                  />
                </Field>
              )}
              {(settings.models?.provider === "copilot" || settings.models?.provider === "copilot-sdk") && (
                <Field label="Model" hint="claude-sonnet-4.5, claude-opus-4.6, gpt-4.1, etc.">
                  <Input
                    value={settings.models?.copilot?.model || ""}
                    onChange={(e) => patch((s) => {
                      s.models = { ...s.models, copilot: { model: e.target.value || undefined } };
                    })}
                    placeholder="claude-sonnet-4.5"
                    className="font-mono text-xs"
                  />
                </Field>
              )}
            </CardContent>
          </Card>

          {/* Channels */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Wifi className="h-4 w-4 text-muted-foreground" />
                Channels
              </CardTitle>
              <CardDescription>Enable messaging channels and configure their credentials.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Enabled Channels">
                <div className="flex gap-2 flex-wrap">
                  {CHANNELS.map((ch) => {
                    const enabled = settings.channels?.enabled?.includes(ch) ?? false;
                    return (
                      <button
                        key={ch}
                        onClick={() => patch((s) => {
                          const current = s.channels?.enabled || [];
                          s.channels = {
                            ...s.channels,
                            enabled: enabled ? current.filter((c) => c !== ch) : [...current, ch],
                          };
                        })}
                        className={`px-3 py-1.5 text-xs border transition-colors ${
                          enabled
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-primary/30"
                        }`}
                      >
                        {ch}
                      </button>
                    );
                  })}
                </div>
              </Field>

              {settings.channels?.enabled?.includes("discord") && (
                <Field label="Discord Bot Token">
                  <Input
                    type="password"
                    value={settings.channels?.discord?.bot_token || ""}
                    onChange={(e) => patch((s) => {
                      s.channels = { ...s.channels, discord: { ...s.channels?.discord, bot_token: e.target.value || undefined } };
                    })}
                    placeholder="Bot token..."
                    className="font-mono text-xs"
                  />
                </Field>
              )}

              {settings.channels?.enabled?.includes("telegram") && (
                <Field label="Telegram Bot Token">
                  <Input
                    type="password"
                    value={settings.channels?.telegram?.bot_token || ""}
                    onChange={(e) => patch((s) => {
                      s.channels = { ...s.channels, telegram: { ...s.channels?.telegram, bot_token: e.target.value || undefined } };
                    })}
                    placeholder="Bot token..."
                    className="font-mono text-xs"
                  />
                </Field>
              )}

              {settings.channels?.enabled?.includes("whatsapp") && (
                <p className="text-xs text-muted-foreground">
                  WhatsApp uses QR code authentication — no token needed. Start the WhatsApp channel to scan.
                </p>
              )}
            </CardContent>
          </Card>

          {/* API */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Shield className="h-4 w-4 text-muted-foreground" />
                API
              </CardTitle>
              <CardDescription>Server binding and authentication. API key is auto-generated if empty.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Bind Host" hint="Use 0.0.0.0 to allow external access">
                <Input
                  value={settings.api?.bind_host || ""}
                  onChange={(e) => patch((s) => { s.api = { ...s.api, bind_host: e.target.value || undefined }; })}
                  placeholder="127.0.0.1"
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="API Key">
                <div className="flex gap-2">
                  <Input
                    type={showApiKey ? "text" : "password"}
                    value={settings.api?.api_key || ""}
                    onChange={(e) => patch((s) => { s.api = { ...s.api, api_key: e.target.value || undefined }; })}
                    placeholder="Auto-generated if empty"
                    className="font-mono text-xs flex-1"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="shrink-0"
                  >
                    {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </Field>
            </CardContent>
          </Card>

          {/* Monitoring */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Monitoring
              </CardTitle>
              <CardDescription>Heartbeat and health check configuration.</CardDescription>
            </CardHeader>
            <CardContent>
              <Field label="Heartbeat Interval" hint="Seconds between proactive check-ins. 0 = disabled.">
                <Input
                  type="number"
                  min={0}
                  value={settings.monitoring?.heartbeat_interval ?? ""}
                  onChange={(e) => patch((s) => {
                    const val = parseInt(e.target.value, 10);
                    s.monitoring = { ...s.monitoring, heartbeat_interval: isNaN(val) ? undefined : val };
                  })}
                  placeholder="3600"
                />
              </Field>
            </CardContent>
          </Card>

          {/* Raw JSON */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Code className="h-4 w-4 text-muted-foreground" />
                  Raw JSON
                  <Badge variant="outline" className="text-[10px]">Advanced</Badge>
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (!showRawJson) setRawJson(JSON.stringify(settings, null, 2));
                    setShowRawJson(!showRawJson);
                  }}
                >
                  {showRawJson ? "Hide" : "Show"}
                </Button>
              </div>
              <CardDescription>
                Direct JSON editing for advanced configuration. Includes agents and teams.
              </CardDescription>
            </CardHeader>
            {showRawJson && (
              <CardContent className="space-y-3">
                <Textarea
                  value={rawJson}
                  onChange={(e) => setRawJson(e.target.value)}
                  rows={24}
                  className="font-mono text-xs leading-relaxed"
                  spellCheck={false}
                />
                <div className="flex justify-end">
                  <Button size="sm" onClick={handleSaveRawJson} disabled={saving}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save JSON
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
