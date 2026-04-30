import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Cpu, CircleDot, Power, RefreshCw, ToggleLeft, Wifi, WifiOff } from "lucide-react";
import { useBoards } from "@/contexts/BoardContext";

export default function BoardControl() {
  const { boards, selectedBoardId, selectBoard, toggleOutput, writeOutputs, refreshBoards, connected, isDemo, getConfig } = useBoards();

  const board = boards.find(b => b.id === selectedBoardId) ?? null;
  const onlineBoards = boards.filter(b => b.status === "online").length;
  const cfg = board ? getConfig(board.id) : null;

  const outName = (i: number) => cfg?.outputNames[i] || `OUT ${i + 1}`;
  const inName = (i: number) => cfg?.inputNames[i] || `Input ${i + 1}`;
  const boardLabel = (b: { id: string }) => {
    const c = getConfig(b.id);
    return c.boardName || b.id;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Board Control</h1>
          <p className="text-muted-foreground text-sm">GPIO output control & input monitoring</p>
        </div>
        <div className="flex items-center gap-3">
          {isDemo && (
            <Badge variant="outline" className="text-[10px] font-mono border-orange-400/40 text-orange-400 bg-orange-500/5">
              <span className="inline-block h-1.5 w-1.5 rounded-full mr-1.5 bg-orange-400" />
              DEMO
            </Badge>
          )}
          <Badge variant="outline" className={`text-[10px] font-mono ${connected ? "border-success/30 text-success bg-success/5" : isDemo ? "border-orange-400/30 text-orange-400 bg-orange-500/5" : "border-destructive/30 text-destructive bg-destructive/5"}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1.5 ${connected ? "bg-success animate-pulse" : "bg-orange-400"}`} />
            {connected ? `${onlineBoards}/${boards.length} Online` : isDemo ? `${onlineBoards} Simulated` : "Backend Offline"}
          </Badge>
          <Button variant="outline" size="sm" className="h-8" onClick={refreshBoards}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {/* Board Selector */}
      <Card className="glass-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary" /> Select Board
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Select value={selectedBoardId ?? ""} onValueChange={selectBoard}>
              <SelectTrigger className="w-72">
                <SelectValue placeholder="Choose a board..." />
              </SelectTrigger>
              <SelectContent>
                {boards.map(b => (
                  <SelectItem key={b.id} value={b.id}>
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${b.status === "online" ? "bg-success" : "bg-destructive"}`} />
                      {boardLabel(b)} <span className={`text-[10px] ml-1 ${b.status === "online" ? "text-success" : "text-destructive"}`}>({b.status})</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {board && (
              <div className="flex items-center gap-3">
                <Badge variant="outline" className={board.status === "online" ? "border-success/30 text-success" : "border-destructive/30 text-destructive"}>
                  {board.status === "online" ? <Wifi className="mr-1 h-3 w-3" /> : <WifiOff className="mr-1 h-3 w-3" />}
                  {board.status}
                </Badge>
                <span className="text-xs text-muted-foreground font-mono">{board.ip}:{board.port}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {!board ? (
        <Card className="glass-card border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center space-y-3">
            <Cpu className="h-10 w-10 text-muted-foreground/30" />
            <p className="text-muted-foreground">Select a board to control its outputs and view inputs</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Outputs Panel */}
            <Card className="glass-card lg:col-span-2">
              <CardHeader className="pb-3 border-b border-border/20">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ToggleLeft className="h-4 w-4 text-orange-400" /> Outputs (Relay Control)
                  </CardTitle>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="h-7 text-[10px] uppercase" onClick={() => writeOutputs(board.id, Array(15).fill(true))}>
                      All ON
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-[10px] uppercase" onClick={() => writeOutputs(board.id, Array(15).fill(false))}>
                      All OFF
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {board.outputs.map((val, i) => (
                    <div
                      key={i}
                      className={`flex items-center justify-between p-3 rounded-lg border transition-all ${
                        val ? "bg-orange-500/10 border-orange-500/30" : "bg-muted/30 border-border/30"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Power className={`h-4 w-4 ${val ? "text-orange-400" : "text-muted-foreground/40"}`} />
                        <div>
                          <p className="text-xs font-bold">{outName(i)}</p>
                          <p className={`text-[9px] uppercase font-mono ${val ? "text-orange-400" : "text-muted-foreground/50"}`}>
                            {val ? "ON" : "OFF"}
                          </p>
                        </div>
                      </div>
                      <Switch checked={val} onCheckedChange={(checked) => toggleOutput(board.id, i, checked)} />
                    </div>
                  ))}
                </div>

                <div className="mt-4 pt-3 border-t border-border/20 flex items-center gap-3">
                  <span className="text-[9px] uppercase font-bold text-muted-foreground tracking-wider">Raw Bytes:</span>
                  <code className="text-xs font-mono text-primary">
                    {(() => {
                      let b0 = 0, b1 = 0;
                      board.outputs.forEach((v, i) => {
                        if (v) { if (i < 8) b0 |= 1 << i; else b1 |= 1 << (i - 8); }
                      });
                      return `0x${b0.toString(16).padStart(2, '0').toUpperCase()} 0x${b1.toString(16).padStart(2, '0').toUpperCase()}`;
                    })()}
                  </code>
                  <span className="text-[9px] text-muted-foreground">({board.outputs.filter(Boolean).length}/15 active)</span>
                </div>
              </CardContent>
            </Card>

            {/* Inputs Panel */}
            <Card className="glass-card">
              <CardHeader className="pb-3 border-b border-border/20">
                <CardTitle className="text-base flex items-center gap-2">
                  <CircleDot className="h-4 w-4 text-blue-400" /> Inputs (Sensors)
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-3">
                {board.inputs.map((val, i) => (
                  <div key={i} className={`flex items-center gap-4 p-4 rounded-lg border transition-all ${
                    val ? "bg-green-500/10 border-green-500/30" : "bg-muted/30 border-border/30"
                  }`}>
                    <div className={`h-5 w-5 rounded-full border-2 transition-all ${
                      val ? "bg-green-400 border-green-300 shadow-[0_0_12px_rgba(74,222,128,0.5)]" : "bg-muted border-border"
                    }`} />
                    <div className="flex-1">
                      <p className="text-sm font-bold">{inName(i)}</p>
                      <p className={`text-[10px] uppercase font-mono ${val ? "text-green-400" : "text-muted-foreground/50"}`}>
                        {val ? "HIGH" : "LOW"}
                      </p>
                    </div>
                    <Badge variant="outline" className={`text-[10px] ${val ? "border-green-400/30 text-green-400" : "opacity-40"}`}>
                      {val ? "1" : "0"}
                    </Badge>
                  </div>
                ))}

                <div className="pt-3 border-t border-border/20 flex items-center gap-3">
                  <span className="text-[9px] uppercase font-bold text-muted-foreground tracking-wider">Raw:</span>
                  <code className="text-xs font-mono text-blue-400">
                    {(() => {
                      let b = 0;
                      board.inputs.forEach((v, i) => { if (v) b |= 1 << i; });
                      return `0x${b.toString(16).padStart(2, '0').toUpperCase()}`;
                    })()}
                  </code>
                </div>
              </CardContent>
            </Card>
          </div>

        </>
      )}

      {/* All Boards Overview */}
      {boards.length > 1 && (
        <Card className="glass-card">
          <CardHeader className="pb-3 border-b border-border/20">
            <CardTitle className="text-base">All Boards Overview</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 bg-muted/30">
                    <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px]">Board</th>
                    <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px]">Status</th>
                    <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px]">IP:Port</th>
                    <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px]">Outputs</th>
                    <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px]">Inputs</th>
                    <th className="text-left p-3 text-muted-foreground font-bold uppercase text-[10px]">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {boards.map(b => (
                    <tr key={b.id} className={`border-b border-border/20 hover:bg-accent/20 transition-colors ${b.id === selectedBoardId ? "bg-primary/5" : ""}`}>
                      <td className="p-3 font-mono font-bold text-xs">{boardLabel(b)}</td>
                      <td className="p-3">
                        <Badge variant="outline" className={`text-[10px] ${b.status === "online" ? "border-success/30 text-success" : "border-destructive/30 text-destructive"}`}>
                          <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1.5 ${b.status === "online" ? "bg-success animate-pulse" : "bg-destructive"}`} />
                          {b.status}
                        </Badge>
                      </td>
                      <td className="p-3 font-mono text-xs text-muted-foreground">{b.ip}:{b.port}</td>
                      <td className="p-3">
                        <div className="flex gap-0.5">
                          {b.outputs.map((v, i) => (
                            <div key={i} className={`h-3 w-3 rounded-sm ${v ? "bg-orange-400" : "bg-muted"}`} title={`${outName(i)}: ${v ? "ON" : "OFF"}`} />
                          ))}
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="flex gap-1">
                          {b.inputs.map((v, i) => (
                            <div key={i} className={`h-3 w-3 rounded-full ${v ? "bg-green-400" : "bg-muted"}`} title={`${inName(i)}: ${v ? "HIGH" : "LOW"}`} />
                          ))}
                        </div>
                      </td>
                      <td className="p-3">
                        <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => selectBoard(b.id)}>Select</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
