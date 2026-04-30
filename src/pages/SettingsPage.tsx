import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

export default function SettingsPage() {
  const [defaultIp, setDefaultIp] = useState("192.168.1.100");
  const [defaultPort, setDefaultPort] = useState("5000");
  const [timeout, setTimeout_] = useState("30");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [realTimeUpdates, setRealTimeUpdates] = useState(true);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  const toggleTheme = (val: boolean) => {
    setDark(val);
    document.documentElement.classList.toggle("dark", val);
  };

  const save = () => toast.success("Settings saved");

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">Application configuration</p>
      </div>

      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="text-base">Connection Defaults</CardTitle>
          <CardDescription>Default values for new connections</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Default IP</Label>
              <Input value={defaultIp} onChange={(e) => setDefaultIp(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Default Port</Label>
              <Input value={defaultPort} onChange={(e) => setDefaultPort(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Timeout (seconds)</Label>
            <Input value={timeout} onChange={(e) => setTimeout_(e.target.value)} type="number" />
          </div>
        </CardContent>
      </Card>

      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="text-base">Preferences</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Dark Mode</Label>
              <p className="text-xs text-muted-foreground">Toggle dark theme</p>
            </div>
            <Switch checked={dark} onCheckedChange={toggleTheme} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Auto-refresh</Label>
              <p className="text-xs text-muted-foreground">Auto-update server monitor</p>
            </div>
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Auto-reconnect</Label>
              <p className="text-xs text-muted-foreground">Reconnect automatically on disconnect</p>
            </div>
            <Switch checked={autoReconnect} onCheckedChange={setAutoReconnect} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Real-time Updates</Label>
              <p className="text-xs text-muted-foreground">Enable live data streaming</p>
            </div>
            <Switch checked={realTimeUpdates} onCheckedChange={setRealTimeUpdates} />
          </div>
        </CardContent>
      </Card>

      <Button onClick={save}>Save Settings</Button>
    </div>
  );
}
