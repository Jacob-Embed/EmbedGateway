import { useState, useEffect, useMemo, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Server, Wifi, Activity, ArrowUpRight, ArrowDownLeft, Plug, Radio } from "lucide-react";
import { Area, AreaChart, BarChart, Bar, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend, Cell } from "recharts";
import { useTcpStream } from "@/hooks/useTcpStream";
import { useBoards } from "@/contexts/BoardContext";

interface ActivityItem {
  id: number;
  direction: "send" | "receive";
  message: string;
  time: string;
}

let actCounter = 0;

export default function Dashboard() {
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [ioFilter, setIoFilter] = useState<"both" | "outputs" | "inputs">("both");

  const { feed, status, activeEndpoint } = useTcpStream();
  const { boards, selectedBoardId, getConfig } = useBoards();

  const isConnected = !!activeEndpoint && (status.includes("Streaming") || status.includes("BRIDGE_CONNECTED") || status.includes("ACTIVE"));

  // Tick every second for live chart sliding
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Sync Global Stream Messages to Local Activity Feed
  useEffect(() => {
    if (feed.length > 0) {
      const latest = feed[feed.length - 1];
      // Decode raw hex to readable text
      let msg = latest.message.trim();
      if (latest.raw) {
        const bytes: number[] = [];
        for (let i = 0; i < latest.raw.length; i += 2) bytes.push(parseInt(latest.raw.slice(i, i + 2), 16));
        try { msg = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes)).trim(); } catch { /* keep raw */ }
      }
      setActivity(prev => [
        {
          id: actCounter++,
          direction: latest.type === 'tx' ? "send" : "receive",
          message: msg,
          time: new Date(latest.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
        },
        ...prev.slice(0, 29)
      ]);
    }
  }, [feed]);

  const { rxCount, txCount, rxFps, txFps } = useTcpStream();

  // Real-time traffic chart: RX and TX packets per second over last 30 seconds
  const trafficData = useMemo(() => {
    const WINDOW = 30;
    const nowSec = Math.floor(Date.now() / 1000);
    const rows: { time: string; rx: number; tx: number }[] = [];

    for (let i = WINDOW - 1; i >= 0; i--) {
      const tSec = nowSec - i;
      const time = new Date(tSec * 1000).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' });
      let rx = 0;
      let tx = 0;
      for (const f of feed) {
        const fSec = Math.floor(new Date(f.timestamp).getTime() / 1000);
        if (fSec === tSec) {
          if (f.type === 'rx') rx++;
          else tx++;
        }
      }
      rows.push({ time, rx, tx });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed, tick]);

  // Real-time server data graph: RX bytes per second over last 30 seconds
  const board = boards.find(b => b.id === selectedBoardId);
  const boardCfg = board ? getConfig(board.id) : null;

  // I/O history — record board state every tick for graph
  const ioHistoryRef = useRef<Record<string, number | string>[]>([]);
  useEffect(() => {
    if (!board) return;
    const point: Record<string, number | string> = {
      time: new Date().toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' }),
    };
    if (ioFilter === "both" || ioFilter === "inputs") {
      board.inputs.forEach((v, i) => {
        point[boardCfg?.inputNames[i] || `DI${i+1}`] = v ? 1 : 0;
      });
    }
    if (ioFilter === "both" || ioFilter === "outputs") {
      board.outputs.forEach((v, i) => {
        point[boardCfg?.outputNames[i] || `DO${i+1}`] = v ? 1 : 0;
      });
    }
    ioHistoryRef.current = [...ioHistoryRef.current.slice(-59), point];
  }, [tick, board, ioFilter, boardCfg]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live Dashboard</h1>
          <p className="text-muted-foreground text-sm">Real-time CAN bus monitoring</p>
        </div>
        <Badge variant="outline" className={`text-[10px] font-mono ${isConnected ? "border-success/30 text-success bg-success/5" : "border-destructive/30 text-destructive bg-destructive/5"}`}>
          <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1.5 ${isConnected ? "bg-success animate-pulse" : "bg-destructive"}`} />
          {isConnected ? status : "Disconnected"}
        </Badge>
      </div>

      {/* Live KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="glass-card">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Connection</p>
                <p className="text-2xl font-bold mt-1">{isConnected ? "Online" : "Offline"}</p>
                <p className={`text-xs mt-1 ${isConnected ? "text-success" : "text-destructive"}`}>
                  {isConnected ? `${activeEndpoint!.ip}:${activeEndpoint!.port}` : "No endpoint"}
                </p>
              </div>
              <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${isConnected ? "bg-success/10" : "bg-destructive/10"}`}>
                <Wifi className={`h-5 w-5 ${isConnected ? "text-success" : "text-destructive"}`} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">RX Packets</p>
                <p className="text-2xl font-bold mt-1">{rxCount}</p>
                <p className="text-xs text-blue-400 mt-1">Received  <span className="text-green-400 font-mono">{rxFps} fps</span></p>
              </div>
              <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <ArrowDownLeft className="h-5 w-5 text-blue-400" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">TX Packets</p>
                <p className="text-2xl font-bold mt-1">{txCount}</p>
                <p className="text-xs text-orange-400 mt-1">Transmitted  <span className="text-green-400 font-mono">{txFps} fps</span></p>
              </div>
              <div className="h-10 w-10 rounded-lg bg-orange-500/10 flex items-center justify-center">
                <ArrowUpRight className="h-5 w-5 text-orange-400" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Protocol</p>
                <p className="text-2xl font-bold mt-1 uppercase">{activeEndpoint?.protocol ?? "—"}</p>
                <p className="text-xs text-muted-foreground mt-1">{isConnected ? "Active" : "Idle"}</p>
              </div>
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Radio className="h-5 w-5 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="glass-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Live Traffic (packets/sec)</CardTitle>
              <Badge variant="outline" className="text-[9px] opacity-60">30s window</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trafficData}>
                  <defs>
                    <linearGradient id="rxGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="txGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(25, 95%, 53%)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(25, 95%, 53%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" minTickGap={40} />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Area type="monotone" dataKey="rx" stroke="hsl(217, 91%, 60%)" fill="url(#rxGrad)" strokeWidth={2} name="RX" />
                  <Area type="monotone" dataKey="tx" stroke="hsl(25, 95%, 53%)" fill="url(#txGrad)" strokeWidth={2} name="TX" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">I/O Live Graph</CardTitle>
              <div className="flex gap-1">
                {(["both","outputs","inputs"] as const).map(f => (
                  <Button key={f} variant={ioFilter === f ? "default" : "outline"} size="sm"
                    className={`h-6 text-[9px] px-2 ${ioFilter === f ? "bg-primary" : ""}`}
                    onClick={() => { setIoFilter(f); ioHistoryRef.current = []; }}>
                    {f === "both" ? "All" : f === "outputs" ? "Outputs" : "Inputs"}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-[250px]">
              {!board ? (
                <div className="h-full flex items-center justify-center text-muted-foreground/50 italic text-sm">Connect a board to see I/O graph</div>
              ) : ioHistoryRef.current.length < 2 ? (
                <div className="h-full flex items-center justify-center text-muted-foreground/50 italic text-sm">Collecting data...</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={ioHistoryRef.current}>
                    <defs>
                      <linearGradient id="outGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(25, 95%, 53%)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(25, 95%, 53%)" stopOpacity={0} />
                      </linearGradient>
                      {[0,1,2,3].map(i => (
                        <linearGradient key={i} id={`inGrad${i}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={["#22c55e","#10b981","#14b8a6","#06b6d4"][i]} stopOpacity={0.2} />
                          <stop offset="95%" stopColor={["#22c55e","#10b981","#14b8a6","#06b6d4"][i]} stopOpacity={0} />
                        </linearGradient>
                      ))}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="time" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" minTickGap={40} />
                    <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" domain={[0, 1]} ticks={[0, 1]}
                      tickFormatter={(v: number) => v === 1 ? "ON/HIGH" : "OFF/LOW"} width={50}
                    />
                    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: 10 }}
                      formatter={(v: number, name: string) => {
                        const isInput = name.startsWith("DI") || (boardCfg?.inputNames || []).includes(name);
                        return v === 1 ? (isInput ? "HIGH" : "ON") : (isInput ? "LOW" : "OFF");
                      }} />
                    <Legend wrapperStyle={{ fontSize: 8 }} />
                    {(ioFilter === "both" || ioFilter === "outputs") && board.outputs.map((_, i) => {
                      const colors = ["#f97316","#fb923c","#fbbf24","#facc15","#a3e635","#4ade80","#22d3ee","#60a5fa","#818cf8","#a78bfa","#c084fc","#e879f9","#f472b6","#fb7185","#ef4444"];
                      return <Area key={`o${i}`} type="stepAfter" dataKey={boardCfg?.outputNames[i] || `DO${i+1}`}
                        stroke={colors[i]} fill="transparent" strokeWidth={1.5} isAnimationActive={false} />;
                    })}
                    {(ioFilter === "both" || ioFilter === "inputs") && board.inputs.map((_, i) => (
                      <Area key={`i${i}`} type="stepAfter" dataKey={boardCfg?.inputNames[i] || `DI${i+1}`}
                        stroke={["#22c55e","#10b981","#14b8a6","#06b6d4"][i]} fill={`url(#inGrad${i})`}
                        strokeWidth={2} isAnimationActive={false} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bottom row: connected servers + live activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="glass-card">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Server className="h-4 w-4 text-primary" /> Connected Servers</CardTitle></CardHeader>
          <CardContent>
            {!isConnected ? (
              <div className="flex flex-col items-center justify-center py-8 text-center space-y-2">
                <Plug className="h-8 w-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No servers connected</p>
                <p className="text-xs text-muted-foreground/60">Go to Connect page to add an endpoint</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between py-3 px-3 rounded-lg bg-success/5 border border-success/10">
                  <div className="flex items-center gap-3">
                    <span className="h-2.5 w-2.5 rounded-full bg-success animate-pulse" />
                    <div>
                      <p className="text-sm font-mono font-medium">{activeEndpoint!.ip}:{activeEndpoint!.port}</p>
                      <p className="text-[10px] text-muted-foreground uppercase">{activeEndpoint!.protocol} &middot; {status}</p>
                    </div>
                  </div>
                  <Badge variant="outline" className="border-success/30 text-success text-[10px]">Active</Badge>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="h-4 w-4 text-blue-400" /> Live Activity
              </CardTitle>
              <Badge variant="outline" className="text-[9px] opacity-60">{activity.length} events</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 max-h-[220px] overflow-y-auto">
              {activity.length === 0 ? (
                <p className="text-sm text-muted-foreground/50 italic py-8 text-center">No activity yet</p>
              ) : (
                activity.map(a => (
                  <div key={a.id} className="flex items-center gap-3 py-2 px-2 rounded-md hover:bg-accent/30 transition-colors border-b border-border/20 last:border-0">
                    <div className={`h-6 w-6 rounded-md flex items-center justify-center shrink-0 ${
                      a.direction === "send" ? "bg-orange-500/10" : "bg-blue-500/10"
                    }`}>
                      {a.direction === "send" ? (
                        <ArrowUpRight className="h-3.5 w-3.5 text-orange-400" />
                      ) : (
                        <ArrowDownLeft className="h-3.5 w-3.5 text-blue-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono truncate text-foreground/80">{a.message}</p>
                    </div>
                    <Badge variant="outline" className={`text-[9px] shrink-0 ${
                      a.direction === "send" ? "text-orange-400 border-orange-400/20" : "text-blue-400 border-blue-400/20"
                    }`}>
                      {a.direction === "send" ? "TX" : "RX"}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground font-mono shrink-0 w-16 text-right">{a.time}</span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
