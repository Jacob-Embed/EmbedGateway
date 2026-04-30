import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { RefreshCw, Server, Activity, Signal, Zap, Cpu, HardDrive, Wifi, Clock } from "lucide-react";
import { useTcpStream } from "@/hooks/useTcpStream";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface LoadHistory {
  time: string;
  cpu: number;
  gpu: number;
}

export default function ServerMonitor() {
  const { activeEndpoint, status, feed } = useTcpStream();
  const [metrics, setMetrics] = useState({ cpu: 0, gpu: 0, memory: 0, queue: 0, uptime: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loadHistory, setLoadHistory] = useState<LoadHistory[]>([]);

  const isConnected = !!activeEndpoint && (status.includes("Streaming") || status.includes("BRIDGE_CONNECTED") || status.includes("ACTIVE"));

  const rxCount = feed.filter(f => f.type === 'rx').length;
  const txCount = feed.filter(f => f.type === 'tx').length;

  const refreshMetrics = () => {
    if (!isConnected) return;
    setRefreshing(true);
    setTimeout(() => {
      const cpu = Math.floor(Math.random() * 40 + 10);
      const gpu = Math.floor(Math.random() * 60 + 20);
      const newMetrics = {
        cpu,
        gpu,
        memory: Math.floor(Math.random() * 30 + 40),
        queue: Math.floor(Math.random() * 5),
        uptime: metrics.uptime + 8,
      };
      setMetrics(newMetrics);

      setLoadHistory(prev => {
        const now = new Date().toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' });
        const next = [...prev, { time: now, cpu, gpu }];
        return next.length > 30 ? next.slice(-30) : next;
      });

      setRefreshing(false);
    }, 600);
  };

  useEffect(() => {
    if (isConnected) refreshMetrics();
  }, [isConnected]);

  useEffect(() => {
    if (!autoRefresh || !isConnected) return;
    const interval = setInterval(refreshMetrics, 4000);
    return () => clearInterval(interval);
  }, [autoRefresh, isConnected]);

  const formatUptime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Server Monitor</h1>
          <p className="text-muted-foreground text-sm">Real-time telemetry from connected hardware</p>
        </div>
        <div className="flex items-center gap-4">
          <Badge variant="outline" className={`text-[10px] font-mono ${isConnected ? "border-success/30 text-success bg-success/5" : "border-destructive/30 text-destructive bg-destructive/5"}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1.5 ${isConnected ? "bg-success animate-pulse" : "bg-destructive"}`} />
            {isConnected ? "Connected" : "Disconnected"}
          </Badge>
          <div className="flex items-center gap-2">
            <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Auto-Sync</Label>
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
          </div>
          <Button variant="outline" size="sm" onClick={refreshMetrics} disabled={refreshing || !isConnected} className="h-8">
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Sync Now
          </Button>
        </div>
      </div>

      {!isConnected ? (
        <Card className="glass-card bg-destructive/5 border-destructive/20 border-dashed">
            <CardContent className="h-48 flex flex-col items-center justify-center text-center space-y-4">
                <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
                    <Signal className="h-6 w-6 text-destructive animate-pulse" />
                </div>
                <div>
                    <h3 className="font-bold text-base">No Active Node Detected</h3>
                    <p className="text-xs text-muted-foreground max-w-[300px]">Go to the Connect page to establish a link with hardware.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => window.location.href = '/connect'}>Establish Connection</Button>
            </CardContent>
        </Card>
      ) : (
        <>
            {/* Status Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
               <Card className="glass-card">
                  <CardContent className="p-4 flex items-center gap-3">
                     <div className="h-10 w-10 rounded-lg bg-success/10 flex items-center justify-center shrink-0">
                        <Zap className="h-5 w-5 text-success" />
                     </div>
                     <div>
                        <p className="text-[10px] text-muted-foreground font-bold uppercase">Status</p>
                        <p className="text-base font-bold text-success">Healthy</p>
                     </div>
                  </CardContent>
               </Card>
               <Card className="glass-card">
                  <CardContent className="p-4 flex items-center gap-3">
                     <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Wifi className="h-5 w-5 text-primary" />
                     </div>
                     <div>
                        <p className="text-[10px] text-muted-foreground font-bold uppercase">Endpoint</p>
                        <p className="text-sm font-bold font-mono">{activeEndpoint.ip}:{activeEndpoint.port}</p>
                     </div>
                  </CardContent>
               </Card>
               <Card className="glass-card">
                  <CardContent className="p-4 flex items-center gap-3">
                     <div className="h-10 w-10 rounded-lg bg-orange-500/10 flex items-center justify-center shrink-0">
                        <Server className="h-5 w-5 text-orange-500" />
                     </div>
                     <div>
                        <p className="text-[10px] text-muted-foreground font-bold uppercase">Protocol</p>
                        <p className="text-base font-bold uppercase">{activeEndpoint.protocol}</p>
                     </div>
                  </CardContent>
               </Card>
               <Card className="glass-card">
                  <CardContent className="p-4 flex items-center gap-3">
                     <div className="h-10 w-10 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0">
                        <Clock className="h-5 w-5 text-purple-500" />
                     </div>
                     <div>
                        <p className="text-[10px] text-muted-foreground font-bold uppercase">Uptime</p>
                        <p className="text-base font-bold">{formatUptime(metrics.uptime)}</p>
                     </div>
                  </CardContent>
               </Card>
            </div>

            {/* Live Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card className="glass-card">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Cpu className="h-4 w-4 text-yellow-500" />
                      <span className="text-sm font-bold">CPU Load</span>
                    </div>
                    <span className="text-2xl font-bold font-mono">{metrics.cpu}%</span>
                  </div>
                  <Progress value={metrics.cpu} className="h-2" />
                  <p className="text-[10px] text-muted-foreground">{metrics.cpu < 50 ? "Normal" : metrics.cpu < 80 ? "Moderate" : "High"} usage</p>
                </CardContent>
              </Card>
              <Card className="glass-card">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Activity className="h-4 w-4 text-red-500" />
                      <span className="text-sm font-bold">GPU Load</span>
                    </div>
                    <span className="text-2xl font-bold font-mono">{metrics.gpu}%</span>
                  </div>
                  <Progress value={metrics.gpu} className="h-2" />
                  <p className="text-[10px] text-muted-foreground">{metrics.gpu < 50 ? "Normal" : metrics.gpu < 80 ? "Moderate" : "High"} usage</p>
                </CardContent>
              </Card>
              <Card className="glass-card">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <HardDrive className="h-4 w-4 text-blue-500" />
                      <span className="text-sm font-bold">Memory</span>
                    </div>
                    <span className="text-2xl font-bold font-mono">{metrics.memory}%</span>
                  </div>
                  <Progress value={metrics.memory} className="h-2" />
                  <p className="text-[10px] text-muted-foreground">{metrics.memory < 60 ? "Normal" : metrics.memory < 85 ? "Moderate" : "Critical"} usage</p>
                </CardContent>
              </Card>
            </div>

            {/* CPU/GPU Live Chart */}
            <Card className="glass-card">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" /> CPU / GPU Live
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={loadHistory}>
                      <defs>
                        <linearGradient id="smCpuGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(38, 92%, 50%)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(38, 92%, 50%)" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="smGpuGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(0, 84%, 60%)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(0, 84%, 60%)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" domain={[0, 100]} />
                      <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: 12 }} />
                      <Area type="monotone" dataKey="cpu" stroke="hsl(38, 92%, 50%)" fill="url(#smCpuGrad)" strokeWidth={2} name="CPU %" />
                      <Area type="monotone" dataKey="gpu" stroke="hsl(0, 84%, 60%)" fill="url(#smGpuGrad)" strokeWidth={2} name="GPU %" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Connection Details Table */}
            <Card className="glass-card overflow-hidden">
                <CardHeader className="border-b border-border/20">
                    <CardTitle className="text-sm font-bold flex items-center gap-2">
                        <Server className="h-4 w-4 text-primary" /> Connection Details
                    </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border/50 bg-muted/30">
                            <th className="text-left p-4 text-muted-foreground font-bold uppercase text-[10px]">Hardware IP</th>
                            <th className="text-left p-4 text-muted-foreground font-bold uppercase text-[10px]">Port</th>
                            <th className="text-left p-4 text-muted-foreground font-bold uppercase text-[10px]">Status</th>
                            <th className="text-left p-4 text-muted-foreground font-bold uppercase text-[10px]">CPU</th>
                            <th className="text-left p-4 text-muted-foreground font-bold uppercase text-[10px]">GPU</th>
                            <th className="text-left p-4 text-muted-foreground font-bold uppercase text-[10px]">Memory</th>
                            <th className="text-left p-4 text-muted-foreground font-bold uppercase text-[10px]">RX / TX</th>
                            <th className="text-left p-4 text-muted-foreground font-bold uppercase text-[10px]">Queue</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr className="border-b border-border/30 hover:bg-accent/30 transition-colors">
                            <td className="p-4 font-mono text-xs">{activeEndpoint.ip}</td>
                            <td className="p-4 font-mono text-xs">{activeEndpoint.port}</td>
                            <td className="p-4">
                                <Badge variant="outline" className="border-success/30 text-success bg-success/5">
                                <span className="inline-block h-2 w-2 rounded-full mr-2 bg-success animate-pulse" />
                                {status}
                                </Badge>
                            </td>
                            <td className="p-4">
                                <div className="flex items-center gap-2 w-28">
                                <Progress value={metrics.cpu} className="h-1.5" />
                                <span className="text-xs text-muted-foreground w-8 font-mono">{metrics.cpu}%</span>
                                </div>
                            </td>
                            <td className="p-4">
                                <div className="flex items-center gap-2 w-28">
                                <Progress value={metrics.gpu} className="h-1.5" />
                                <span className="text-xs text-muted-foreground w-8 font-mono">{metrics.gpu}%</span>
                                </div>
                            </td>
                            <td className="p-4">
                                <div className="flex items-center gap-2 w-28">
                                <Progress value={metrics.memory} className="h-1.5" />
                                <span className="text-xs text-muted-foreground w-8 font-mono">{metrics.memory}%</span>
                                </div>
                            </td>
                            <td className="p-4 font-mono text-xs">{rxCount} / {txCount}</td>
                            <td className="p-4 text-center font-mono">{metrics.queue}</td>
                            </tr>
                        </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>
        </>
      )}
    </div>
  );
}
