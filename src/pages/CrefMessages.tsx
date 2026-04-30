import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Trash2, Power, ArrowUp, ArrowDown, ScrollText, Download } from "lucide-react";
import { useBoards } from "@/contexts/BoardContext";

export default function CrefMessages() {
  const { boards, logs, clearLogs, getConfig } = useBoards();
  const [boardFilter, setBoardFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "output" | "input">("all");
  const [search, setSearch] = useState("");

  const boardLabel = (id: string) => {
    const c = getConfig(id);
    return c.boardName || id;
  };

  const filtered = logs
    .filter(l => boardFilter === "all" || l.boardId === boardFilter)
    .filter(l => typeFilter === "all" || l.type === typeFilter)
    .filter(l => {
      if (!search) return true;
      const s = search.toLowerCase();
      return l.label.toLowerCase().includes(s) || l.boardId.toLowerCase().includes(s);
    })
    .slice(-200)
    .reverse();

  const exportLogs = () => {
    const lines = filtered.reverse().map(l =>
      `${new Date(l.timestamp).toLocaleString()}\t${l.boardId}\t${l.type}\t${l.label}\t${l.value ? (l.type === "output" ? "ON" : "HIGH") : (l.type === "output" ? "OFF" : "LOW")}`
    );
    const csv = "Time\tBoard\tType\tLabel\tValue\n" + lines.join("\n");
    const blob = new Blob([csv], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `board-logs-${new Date().toISOString().slice(0, 10)}.tsv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Stats
  const outputChanges = logs.filter(l => l.type === "output").length;
  const inputChanges = logs.filter(l => l.type === "input").length;
  const boardsWithLogs = new Set(logs.map(l => l.boardId)).size;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Board Logs</h1>
          <p className="text-muted-foreground text-sm">Complete history of output changes and input state transitions</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8" onClick={exportLogs} disabled={filtered.length === 0}>
            <Download className="mr-2 h-3.5 w-3.5" /> Export
          </Button>
          <Button variant="outline" size="sm" className="h-8 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30" onClick={clearLogs}>
            <Trash2 className="mr-2 h-3.5 w-3.5" /> Clear All
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="glass-card">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-orange-500/10 flex items-center justify-center">
              <Power className="h-4 w-4 text-orange-400" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground font-bold uppercase">Output Changes</p>
              <p className="text-lg font-bold">{outputChanges}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="glass-card">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-green-500/10 flex items-center justify-center">
              <ArrowUp className="h-4 w-4 text-green-400" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground font-bold uppercase">Input Transitions</p>
              <p className="text-lg font-bold">{inputChanges}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="glass-card">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <ScrollText className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground font-bold uppercase">Boards Logged</p>
              <p className="text-lg font-bold">{boardsWithLogs}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search by label or board..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={boardFilter} onValueChange={setBoardFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All Boards" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Boards</SelectItem>
            {boards.map(b => (
              <SelectItem key={b.id} value={b.id}>{boardLabel(b.id)} ({b.id})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex gap-1">
          {(["all", "output", "input"] as const).map(f => (
            <Button key={f} variant={typeFilter === f ? "default" : "outline"} size="sm" onClick={() => setTypeFilter(f)} className="text-xs capitalize">
              {f === "all" ? "All" : f === "output" ? "Outputs" : "Inputs"}
            </Button>
          ))}
        </div>
        <Badge variant="outline" className="text-[9px] opacity-60">{filtered.length} entries</Badge>
      </div>

      {/* Log Table */}
      <Card className="glass-card">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-muted/30">
                  <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px] w-28">Time</th>
                  <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px] w-24">Board</th>
                  <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px] w-16">Type</th>
                  <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px]">Label</th>
                  <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px] w-20">From</th>
                  <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px] w-8"></th>
                  <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px] w-20">To</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-muted-foreground/50 italic">
                      No log entries{search || boardFilter !== "all" || typeFilter !== "all" ? " matching filters" : " yet"}
                    </td>
                  </tr>
                ) : (
                  filtered.map(l => (
                    <tr key={l.id} className="border-b border-border/10 hover:bg-accent/20 transition-colors">
                      <td className="p-3 font-mono text-[11px] text-muted-foreground">
                        {new Date(l.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        <span className="block text-[9px] opacity-50">
                          {new Date(l.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                        </span>
                      </td>
                      <td className="p-3">
                        <span className="text-xs font-mono font-bold">{boardLabel(l.boardId)}</span>
                      </td>
                      <td className="p-3">
                        <Badge variant="outline" className={`text-[9px] ${l.type === "output" ? "text-orange-400 border-orange-400/20" : "text-green-400 border-green-400/20"}`}>
                          {l.type === "output" ? "OUT" : "IN"}
                        </Badge>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          {l.type === "output"
                            ? <Power className={`h-3.5 w-3.5 ${l.value ? "text-orange-400" : "text-muted-foreground/40"}`} />
                            : (l.value
                              ? <ArrowUp className="h-3.5 w-3.5 text-green-400" />
                              : <ArrowDown className="h-3.5 w-3.5 text-red-400" />)
                          }
                          <span className="text-xs font-medium">{l.label}</span>
                        </div>
                      </td>
                      <td className="p-3">
                        <span className={`text-xs font-mono ${!l.value
                          ? (l.type === "output" ? "text-orange-400" : "text-green-400")
                          : "text-muted-foreground"
                        }`}>
                          {l.type === "output" ? (l.value ? "OFF" : "ON") : (l.value ? "LOW" : "HIGH")}
                        </span>
                      </td>
                      <td className="p-3 text-muted-foreground text-xs">→</td>
                      <td className="p-3">
                        <span className={`text-xs font-mono font-bold ${l.value
                          ? (l.type === "output" ? "text-orange-400" : "text-green-400")
                          : "text-muted-foreground"
                        }`}>
                          {l.type === "output" ? (l.value ? "ON" : "OFF") : (l.value ? "HIGH" : "LOW")}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
