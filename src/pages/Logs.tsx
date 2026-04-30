import { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, Pause, Play, Trash2, ArrowUpRight, ArrowDownLeft, Download, Wifi, WifiOff } from "lucide-react";
import { useTcpStream } from "@/hooks/useTcpStream";

export default function Logs() {
  const { feed, status, activeEndpoint, clearFeed } = useTcpStream();
  const [filter, setFilter] = useState<"all" | "tx" | "rx">("all");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [frozenFeed, setFrozenFeed] = useState(feed);
  const bottomRef = useRef<HTMLDivElement>(null);

  const isConnected = !!activeEndpoint && (status.includes("Streaming") || status.includes("BRIDGE_CONNECTED") || status.includes("ACTIVE"));

  // Freeze feed when paused
  useEffect(() => {
    if (paused) {
      setFrozenFeed([...feed]);
    }
  }, [paused]);

  // Auto-scroll
  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [feed, paused]);

  const displayFeed = paused ? frozenFeed : feed;

  const filtered = displayFeed.filter(entry => {
    if (filter !== "all" && entry.type !== filter) return false;
    if (search && !entry.message.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const formatMessage = (entry: { message: string; raw?: string }): string => {
    if (!entry.raw) return entry.message.trim();
    const bytes: number[] = [];
    for (let i = 0; i < entry.raw.length; i += 2) bytes.push(parseInt(entry.raw.slice(i, i + 2), 16));
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
    } catch {
      return entry.message.trim();
    }
  };

  const exportLogs = () => {
    const lines = filtered.map(e =>
      `${new Date(e.timestamp).toLocaleString()}\t${e.type.toUpperCase()}\t${formatMessage(e)}`
    );
    const csv = "Time\tType\tMessage\n" + lines.join("\n");
    const blob = new Blob([csv], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs-${new Date().toISOString().slice(0, 10)}.tsv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const rxCount = feed.filter(f => f.type === 'rx').length;
  const txCount = feed.filter(f => f.type === 'tx').length;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Logs</h1>
          <p className="text-muted-foreground text-sm">Live TX/RX communication stream</p>
        </div>
        <Badge variant="outline" className={`text-[10px] font-mono ${isConnected ? "border-success/30 text-success bg-success/5" : "border-destructive/30 text-destructive bg-destructive/5"}`}>
          {isConnected ? <Wifi className="mr-1 h-3 w-3" /> : <WifiOff className="mr-1 h-3 w-3" />}
          {isConnected ? `${activeEndpoint!.ip}:${activeEndpoint!.port}` : "Disconnected"}
        </Badge>
      </div>

      {/* Stats */}
      <div className="flex gap-4">
        <Badge variant="outline" className="text-[10px] border-blue-400/30 text-blue-400">RX: {rxCount}</Badge>
        <Badge variant="outline" className="text-[10px] border-orange-400/30 text-orange-400">TX: {txCount}</Badge>
        <Badge variant="outline" className="text-[10px] opacity-60">Total: {feed.length}</Badge>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search logs..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <div className="flex gap-2">
          {(["all", "rx", "tx"] as const).map(f => (
            <Button key={f} variant={filter === f ? "default" : "outline"} size="sm" onClick={() => setFilter(f)} className="text-xs uppercase">
              {f}
            </Button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => setPaused(!paused)}>
          {paused ? <Play className="mr-1 h-3 w-3" /> : <Pause className="mr-1 h-3 w-3" />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button variant="outline" size="sm" onClick={exportLogs} disabled={filtered.length === 0}>
          <Download className="mr-1 h-3 w-3" /> Export
        </Button>
        <Button variant="outline" size="sm" className="hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30" onClick={clearFeed}>
          <Trash2 className="mr-1 h-3 w-3" /> Clear
        </Button>
      </div>

      {/* Log Stream */}
      <Card className="glass-card">
        <CardContent className="p-0">
          <div className="h-[500px] overflow-y-auto font-mono text-xs">
            {filtered.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground/50 italic">
                {feed.length === 0 ? "No data — connect to hardware to see logs" : "No results matching filter"}
              </div>
            ) : (
              filtered.map((entry, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-2 border-b border-border/20 hover:bg-accent/20 transition-colors">
                  <span className="text-muted-foreground w-20 shrink-0">
                    {new Date(entry.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <div className={`h-5 w-5 rounded-md flex items-center justify-center shrink-0 ${
                    entry.type === 'tx' ? "bg-orange-500/10" : "bg-blue-500/10"
                  }`}>
                    {entry.type === 'tx'
                      ? <ArrowUpRight className="h-3 w-3 text-orange-400" />
                      : <ArrowDownLeft className="h-3 w-3 text-blue-400" />
                    }
                  </div>
                  <Badge variant="outline" className={`text-[9px] w-8 justify-center shrink-0 ${
                    entry.type === 'tx' ? "text-orange-400 border-orange-400/20" : "text-blue-400 border-blue-400/20"
                  }`}>
                    {entry.type.toUpperCase()}
                  </Badge>
                  <span className="text-foreground/90 break-all">{formatMessage(entry)}</span>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
