import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Settings, Cpu, Wifi, WifiOff, Timer, Zap, Plus, Trash2, Save, X, Play, Square } from "lucide-react";
import { useBoards, TimerOutputConfig } from "@/contexts/BoardContext";

type PopupMode = null | "timer" | "rule" | "both";

export default function BoardConfig() {
  const { boards, selectedBoardId, selectBoard, getConfig, updateConfig, addTimerPreset, removeTimerPreset, runAutoTimer, stopAutoTimer, runningTimers, addInputRule, removeInputRule, toggleInputRule } = useBoards();

  const board = boards.find(b => b.id === selectedBoardId) ?? null;
  const cfg = board ? getConfig(board.id) : null;
  const boardRunning = board ? (runningTimers[board.id] || []) : [];

  const [popupMode, setPopupMode] = useState<PopupMode>(null);

  // Timer form — multiple outputs each with ON/OFF delay
  const [tName, setTName] = useState("");
  const [tOutputs, setTOutputs] = useState<TimerOutputConfig[]>([]);
  const [tStartWithMap, setTStartWithMap] = useState<Record<number, boolean>>({}); // outputIndex -> startValue
  const [tAddOut, setTAddOut] = useState("0");
  const [tAddOn, setTAddOn] = useState("5");
  const [tAddOff, setTAddOff] = useState("1");
  const [tAddStart, setTAddStart] = useState("on"); // "on" | "off"
  const [tAddOnAuto, setTAddOnAuto] = useState(true);
  const [tAddOffAuto, setTAddOffAuto] = useState(true);

  // Rule form
  const [rName, setRName] = useState("");
  const [rInput, setRInput] = useState("0");
  const [rTrigger, setRTrigger] = useState<"high" | "low">("high");
  const [rOutputs, setROutputs] = useState<{ outputIndex: number; value: boolean }[]>([]);
  const [rAddOut, setRAddOut] = useState("0");
  const [rAddVal, setRAddVal] = useState("true");

  const outName = (i: number) => cfg?.outputNames[i] || `DO${i + 1}`;
  const inName = (i: number) => cfg?.inputNames[i] || `DI${i + 1}`;

  const handleSaveTimer = () => {
    if (!board || tOutputs.length === 0) return;
    addTimerPreset(board.id, {
      name: tName || `Timer ${(cfg?.timerPresets.length || 0) + 1}`,
      outputs: [...tOutputs],
      enabled: true,
    });
    setTName(""); setTOutputs([]); setTStartWithMap({});
  };

  const handleSaveRule = () => {
    if (!board || rOutputs.length === 0) return;
    addInputRule(board.id, { name: rName || `Rule ${(cfg?.inputRules.length || 0) + 1}`, inputIndex: Number(rInput), trigger: rTrigger, actions: [...rOutputs], enabled: true });
    setRName(""); setROutputs([]);
  };

  // Save Both — linked timer + rule
  const handleSaveBoth = () => {
    if (!board || tOutputs.length === 0 || rOutputs.length === 0) return;
    // Save timer first
    const timerName = tName || `Timer ${(cfg?.timerPresets.length || 0) + 1}`;
    addTimerPreset(board.id, { name: timerName, outputs: [...tOutputs], enabled: true });
    // Save rule linked to this timer
    // Find the timer we just added (will have the latest id)
    setTimeout(() => {
      const latestCfg = getConfig(board.id);
      const latestTimer = latestCfg.timerPresets[latestCfg.timerPresets.length - 1];
      if (latestTimer) {
        addInputRule(board.id, {
          name: rName || `${timerName} Rule`,
          inputIndex: Number(rInput),
          trigger: rTrigger,
          actions: [...rOutputs],
          enabled: true,
          linkedTimerId: latestTimer.id,
        });
      }
    }, 50);
    setTName(""); setTOutputs([]); setTStartWithMap({}); setRName(""); setROutputs([]);
    closePopup();
  };

  const closePopup = () => setPopupMode(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Board Configuration</h1>
        <p className="text-muted-foreground text-sm">Names, timers, and automation rules</p>
      </div>

      {/* Board Selector */}
      <Card className="glass-card">
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Cpu className="h-4 w-4 text-primary" /> Select Board</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {boards.length === 0 && <p className="text-sm text-muted-foreground italic col-span-3">No boards connected</p>}
            {boards.map(b => (
              <button key={b.id} onClick={() => selectBoard(b.id)}
                className={`text-left p-4 rounded-lg border transition-all ${b.id === selectedBoardId ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "border-border/30 hover:bg-accent/30"}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-bold">{getConfig(b.id).boardName || b.id}</span>
                  <Badge variant="outline" className={`text-[9px] ${b.status === "online" ? "border-success/30 text-success" : "border-destructive/30 text-destructive"}`}>
                    {b.status === "online" ? <Wifi className="mr-1 h-2.5 w-2.5" /> : <WifiOff className="mr-1 h-2.5 w-2.5" />}{b.status}
                  </Badge>
                </div>
                <p className="text-[10px] font-mono text-muted-foreground">{b.ip}:{b.port}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {board && cfg && (
        <>
          {/* Names + Automation */}
          <Card className="glass-card">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><Settings className="h-4 w-4 text-primary" /> Board Name & Labels</CardTitle>
                <Select value="" onValueChange={v => setPopupMode(v as PopupMode)}>
                  <SelectTrigger className="w-52 h-9 text-xs font-medium">
                    <div className="flex items-center gap-2"><Plus className="h-3.5 w-3.5" /> Add Automation</div>
                  </SelectTrigger>
                  <SelectContent className="w-52">
                    <SelectItem value="timer" className="text-xs py-2.5"><div className="flex items-center gap-2"><Timer className="h-4 w-4 text-yellow-400" /> Output Timer</div></SelectItem>
                    <SelectItem value="rule" className="text-xs py-2.5"><div className="flex items-center gap-2"><Zap className="h-4 w-4 text-purple-400" /> Input Rule</div></SelectItem>
                    <SelectItem value="both" className="text-xs py-2.5"><div className="flex items-center gap-2"><Settings className="h-4 w-4 text-primary" /> Both</div></SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input value={cfg.boardName} onChange={e => updateConfig(board.id, { boardName: e.target.value })} placeholder={board.id} className="h-8 text-xs max-w-xs" />
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                  <Label className="text-[10px] uppercase font-bold text-muted-foreground mb-2 block">Outputs (15)</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {Array.from({ length: 15 }, (_, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className={`text-[10px] font-bold w-9 shrink-0 ${board.outputs[i] ? "text-orange-400" : "text-muted-foreground/50"}`}>DO{i+1}</span>
                        <Input value={cfg.outputNames[i] || ""} onChange={e => { const n = [...cfg.outputNames]; n[i] = e.target.value; updateConfig(board.id, { outputNames: n }); }}
                          placeholder={`DO${i+1}`} className="h-8 text-xs font-mono" />
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <Label className="text-[10px] uppercase font-bold text-muted-foreground mb-2 block">Inputs (4)</Label>
                  <div className="space-y-2">
                    {Array.from({ length: 4 }, (_, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <div className={`h-3 w-3 rounded-full shrink-0 ${board.inputs[i] ? "bg-green-400" : "bg-muted"}`} />
                        <span className="text-[10px] font-bold w-8 shrink-0">DI{i+1}</span>
                        <Input value={cfg.inputNames[i] || ""} onChange={e => { const n = [...cfg.inputNames]; n[i] = e.target.value; updateConfig(board.id, { inputNames: n }); }}
                          placeholder={`DI${i+1}`} className="h-8 text-xs font-mono" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Saved Automations */}
          {(() => {
            // Group linked timer+rule as one card, show standalone ones separately
            const linkedRuleIds = new Set(cfg.inputRules.filter(r => r.linkedTimerId).map(r => r.linkedTimerId!));
            const linkedTimerIds = new Set(cfg.inputRules.filter(r => r.linkedTimerId).map(r => r.linkedTimerId!));
            const standaloneTimers = cfg.timerPresets.filter(t => !linkedTimerIds.has(t.id));
            const standaloneRules = cfg.inputRules.filter(r => !r.linkedTimerId);
            const linkedPairs = cfg.inputRules.filter(r => r.linkedTimerId).map(rule => ({
              rule,
              timer: cfg.timerPresets.find(t => t.id === rule.linkedTimerId),
            })).filter(p => p.timer);

            if (standaloneTimers.length === 0 && standaloneRules.length === 0 && linkedPairs.length === 0) return null;

            return (
              <Card className="glass-card">
                <CardHeader className="pb-2"><CardTitle className="text-base">Saved Automations</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {/* Linked pairs — single combined card */}
                  {linkedPairs.map(({ rule, timer }) => {
                    const running = boardRunning.filter(r => r.presetId === timer!.id);
                    return (
                      <div key={`linked-${rule.id}`} className={`p-3 rounded-lg border ${running.length > 0 ? "bg-primary/10 border-primary/30" : rule.enabled ? "bg-primary/5 border-primary/20" : "opacity-40 border-border/20"}`}>
                        <div className="flex items-center gap-3">
                          <Switch checked={rule.enabled} onCheckedChange={() => toggleInputRule(board.id, rule.id)} />
                          <div className="flex items-center gap-1.5">
                            <Zap className="h-4 w-4 text-purple-400" />
                            <Timer className={`h-4 w-4 ${running.length > 0 ? "text-yellow-400 animate-pulse" : "text-yellow-400/50"}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold truncate">{rule.name}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {inName(rule.inputIndex)} → <span className={rule.trigger === "high" ? "text-green-400" : "text-red-400"}>{rule.trigger.toUpperCase()}</span>
                            </p>
                            <div className="flex gap-1 mt-1 flex-wrap">
                              {timer!.outputs.map((o, j) => (
                                <Badge key={j} variant="outline" className="text-[8px] gap-0.5">
                                  <span className="text-orange-400">{outName(o.outputIndex)}</span>
                                  <span className="text-green-400">ON:{o.onDelaySec}s</span>
                                  <span className="text-red-400">OFF:{o.offDelaySec}s</span>
                                </Badge>
                              ))}
                            </div>
                          </div>
                          {running.map(r => (
                            <Badge key={`r-${r.outputIndex}`} className="bg-yellow-500/20 text-yellow-400 text-[10px] font-mono animate-pulse shrink-0">
                              DO{r.outputIndex+1} {r.value?"ON":"OFF"} {r.remainingSec}s
                            </Badge>
                          ))}
                          <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive shrink-0" onClick={() => {
                            removeInputRule(board.id, rule.id);
                            if (timer) removeTimerPreset(board.id, timer.id);
                          }}><Trash2 className="h-3 w-3" /></Button>
                        </div>
                      </div>
                    );
                  })}

                  {/* Standalone timers */}
                  {standaloneTimers.map(preset => {
                    const running = boardRunning.filter(r => r.presetId === preset.id);
                    const hasAny = preset.outputs.some(o => o.onAuto || o.offAuto);
                    const isAuto = hasAny;
                    const isRunning = running.length > 0;
                    return (
                      <div key={`t-${preset.id}`} className={`flex items-center gap-3 p-3 rounded-lg border ${isRunning ? "bg-yellow-500/10 border-yellow-500/30" : "bg-muted/20 border-border/30"}`}>
                        <Timer className={`h-4 w-4 shrink-0 ${isRunning ? "text-yellow-400 animate-pulse" : "text-yellow-400/50"}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-bold truncate">{preset.name}</p>
                            <Badge variant="outline" className={`text-[7px] ${isAuto ? "border-green-400/30 text-green-400" : "border-blue-400/30 text-blue-400"}`}>
                              {isAuto ? "AUTO" : "MANUAL"}
                            </Badge>
                          </div>
                          <div className="flex gap-1 mt-0.5 flex-wrap">
                            {preset.outputs.map((o, j) => (
                              <Badge key={j} variant="outline" className="text-[8px] gap-0.5">
                                <span className="text-orange-400">{outName(o.outputIndex)}</span>
                                <span className={o.onAuto ? "text-green-400" : "text-blue-400"}>ON:{o.onDelaySec}s{o.onAuto ? "" : "(M)"}</span>
                                <span className={o.offAuto ? "text-red-400" : "text-blue-400"}>OFF:{o.offDelaySec}s{o.offAuto ? "" : "(M)"}</span>
                              </Badge>
                            ))}
                          </div>
                        </div>
                        {running.map(r => (
                          <Badge key={`r-${r.outputIndex}`} className="bg-yellow-500/20 text-yellow-400 text-[10px] font-mono animate-pulse shrink-0">
                            DO{r.outputIndex+1} {r.value?"ON":"OFF"} {r.remainingSec}s
                          </Badge>
                        ))}
                        {isAuto && (
                          !isRunning ? (
                            <Button size="sm" className="h-7 text-[10px] gap-1 bg-green-600 hover:bg-green-500 shrink-0" onClick={() => runAutoTimer(board.id, preset.id)}>
                              <Play className="h-3 w-3" /> Run
                            </Button>
                          ) : (
                            <Button size="sm" variant="destructive" className="h-7 text-[10px] gap-1 shrink-0" onClick={() => stopAutoTimer(board.id, preset.id)}>
                              <Square className="h-3 w-3" /> Stop
                            </Button>
                          )
                        )}
                        <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive shrink-0" onClick={() => removeTimerPreset(board.id, preset.id)}><Trash2 className="h-3 w-3" /></Button>
                      </div>
                    );
                  })}

                  {/* Standalone rules */}
                  {standaloneRules.map(rule => (
                    <div key={`r-${rule.id}`} className={`flex items-center gap-3 p-3 rounded-lg border ${rule.enabled ? "bg-purple-500/5 border-purple-500/20" : "opacity-40 border-border/20"}`}>
                      <Switch checked={rule.enabled} onCheckedChange={() => toggleInputRule(board.id, rule.id)} />
                      <Zap className={`h-4 w-4 shrink-0 ${rule.enabled ? "text-purple-400" : "text-purple-400/30"}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold truncate">{rule.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {inName(rule.inputIndex)} → <span className={rule.trigger === "high" ? "text-green-400" : "text-red-400"}>{rule.trigger.toUpperCase()}</span>
                          {" → "}{rule.actions.map((a, j) => (
                            <span key={j} className={a.value ? "text-orange-400" : "text-muted-foreground"}>
                              {outName(a.outputIndex)}:{a.value?"ON":"OFF"}{j < rule.actions.length-1 ? ", " : ""}
                            </span>
                          ))}
                        </p>
                      </div>
                      <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive shrink-0" onClick={() => removeInputRule(board.id, rule.id)}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
            );
          })()}

          {/* ── POPUP ── */}
          <Dialog open={popupMode !== null} onOpenChange={open => { if (!open) closePopup(); }}>
            <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {popupMode === "timer" && <><Timer className="h-5 w-5 text-yellow-400" /> Add Output Timer</>}
                  {popupMode === "rule" && <><Zap className="h-5 w-5 text-purple-400" /> Add Input Rule</>}
                  {popupMode === "both" && <><Settings className="h-5 w-5 text-primary" /> Add Timer & Rule</>}
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-6 py-2">
                {/* Timer only */}
                {popupMode === "timer" && (
                  <div className="space-y-3 p-4 rounded-lg border border-yellow-500/20 bg-yellow-500/5">
                    <Label className="text-sm font-bold flex items-center gap-2"><Timer className="h-4 w-4 text-yellow-400" /> Output Timer</Label>
                    <div className="space-y-1"><Label className="text-[9px]">Name</Label><Input value={tName} onChange={e => setTName(e.target.value)} placeholder="Timer name" className="h-8 text-xs" /></div>
                    {tOutputs.length > 0 && <div className="space-y-1.5">{tOutputs.map((o, j) => (
                      <div key={j} className="flex items-center gap-2 p-2 rounded bg-muted/30 border border-border/20 flex-wrap">
                        <span className="text-xs font-bold text-orange-400 w-16">{outName(o.outputIndex)}</span>
                        <Badge variant="outline" className={`text-[8px] gap-0.5 ${o.onAuto ? "border-green-400/30 text-green-400" : "border-blue-400/30 text-blue-400"}`}>
                          ON:{o.onDelaySec}s {o.onAuto ? "AUTO" : "MANUAL"}
                        </Badge>
                        <Badge variant="outline" className={`text-[8px] gap-0.5 ${o.offAuto ? "border-red-400/30 text-red-400" : "border-blue-400/30 text-blue-400"}`}>
                          OFF:{o.offDelaySec}s {o.offAuto ? "AUTO" : "MANUAL"}
                        </Badge>
                        <Button variant="ghost" size="icon" className="h-5 w-5 ml-auto hover:text-destructive" onClick={() => setTOutputs(p => p.filter((_, k) => k !== j))}><X className="h-3 w-3" /></Button>
                      </div>
                    ))}</div>}
                    <div className="p-3 rounded border border-border/20 bg-muted/10 space-y-2">
                      <div className="flex items-end gap-2 flex-wrap">
                        <div className="space-y-1"><Label className="text-[9px]">Output</Label><Select value={tAddOut} onValueChange={setTAddOut}><SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger><SelectContent>{Array.from({ length: 15 }, (_, i) => (<SelectItem key={i} value={String(i)} className="text-xs">{outName(i)}</SelectItem>))}</SelectContent></Select></div>
                        <div className="space-y-1"><Label className="text-[9px] text-green-400">ON (sec)</Label><Input type="number" min={0} value={tAddOn} onChange={e => setTAddOn(e.target.value)} className="h-8 w-16 text-xs" /></div>
                        <div className="space-y-1">
                          <Label className="text-[9px] text-green-400">ON mode</Label>
                          <Select value={tAddOnAuto ? "auto" : "manual"} onValueChange={v => setTAddOnAuto(v === "auto")}>
                            <SelectTrigger className="h-8 w-24 text-[10px]"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value="auto" className="text-xs">Auto</SelectItem><SelectItem value="manual" className="text-xs">Manual</SelectItem></SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1"><Label className="text-[9px] text-red-400">OFF (sec)</Label><Input type="number" min={0} value={tAddOff} onChange={e => setTAddOff(e.target.value)} className="h-8 w-16 text-xs" /></div>
                        <div className="space-y-1">
                          <Label className="text-[9px] text-red-400">OFF mode</Label>
                          <Select value={tAddOffAuto ? "auto" : "manual"} onValueChange={v => setTAddOffAuto(v === "auto")}>
                            <SelectTrigger className="h-8 w-24 text-[10px]"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value="auto" className="text-xs">Auto</SelectItem><SelectItem value="manual" className="text-xs">Manual</SelectItem></SelectContent>
                          </Select>
                        </div>
                        <Button variant="outline" size="sm" className="h-8 text-[10px]" onClick={() => setTOutputs(p => [...p.filter(o => o.outputIndex !== Number(tAddOut)), { outputIndex: Number(tAddOut), onDelaySec: Number(tAddOn) || 0, offDelaySec: Number(tAddOff) || 0, onAuto: tAddOnAuto, offAuto: tAddOffAuto }])}><Plus className="mr-1 h-3 w-3" />Add</Button>
                      </div>
                      <p className="text-[9px] text-muted-foreground">
                        Auto = runs automatically on Run click. Manual = delay only on toggle.
                      </p>
                    </div>
                    <Button size="sm" className="bg-yellow-600 hover:bg-yellow-500 text-white w-full" onClick={handleSaveTimer} disabled={tOutputs.length === 0}><Save className="mr-1 h-3 w-3" /> Save Timer</Button>
                  </div>
                )}

                {/* Rule only */}
                {popupMode === "rule" && (
                  <div className="space-y-3 p-4 rounded-lg border border-purple-500/20 bg-purple-500/5">
                    <Label className="text-sm font-bold flex items-center gap-2"><Zap className="h-4 w-4 text-purple-400" /> Input Rule</Label>
                    <p className="text-[10px] text-muted-foreground">Input triggers outputs immediately. Auto-reverses when input goes back.</p>
                    <div className="flex flex-wrap gap-3">
                      <div className="space-y-1 flex-1 min-w-[120px]"><Label className="text-[9px]">Name</Label><Input value={rName} onChange={e => setRName(e.target.value)} placeholder="Rule name" className="h-8 text-xs" /></div>
                      <div className="space-y-1"><Label className="text-[9px]">When Input</Label><Select value={rInput} onValueChange={setRInput}><SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger><SelectContent>{Array.from({ length: 4 }, (_, i) => (<SelectItem key={i} value={String(i)} className="text-xs">{inName(i)}</SelectItem>))}</SelectContent></Select></div>
                      <div className="space-y-1"><Label className="text-[9px]">Goes</Label><Select value={rTrigger} onValueChange={v => setRTrigger(v as "high" | "low")}><SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="high" className="text-xs">HIGH</SelectItem><SelectItem value="low" className="text-xs">LOW</SelectItem></SelectContent></Select></div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-[9px]">Then set outputs:</Label>
                      <div className="flex flex-wrap gap-1.5">{rOutputs.map((o, j) => (<Badge key={j} variant="outline" className="text-[10px] gap-1 pr-1">{outName(o.outputIndex)}→{o.value ? "ON" : "OFF"}<button onClick={() => setROutputs(p => p.filter((_, k) => k !== j))} className="hover:text-destructive"><X className="h-2.5 w-2.5" /></button></Badge>))}</div>
                      <div className="flex items-end gap-2">
                        <Select value={rAddOut} onValueChange={setRAddOut}><SelectTrigger className="h-7 w-32 text-[10px]"><SelectValue /></SelectTrigger><SelectContent>{Array.from({ length: 15 }, (_, i) => (<SelectItem key={i} value={String(i)} className="text-xs">{outName(i)}</SelectItem>))}</SelectContent></Select>
                        <Select value={rAddVal} onValueChange={setRAddVal}><SelectTrigger className="h-7 w-20 text-[10px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="true" className="text-xs">ON</SelectItem><SelectItem value="false" className="text-xs">OFF</SelectItem></SelectContent></Select>
                        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => setROutputs(p => [...p, { outputIndex: Number(rAddOut), value: rAddVal === "true" }])}><Plus className="mr-1 h-3 w-3" />Add</Button>
                      </div>
                    </div>
                    <Button size="sm" className="bg-purple-600 hover:bg-purple-500 text-white w-full" onClick={handleSaveRule} disabled={rOutputs.length === 0}><Save className="mr-1 h-3 w-3" /> Save Rule</Button>
                  </div>
                )}

                {/* Both — unified single form */}
                {popupMode === "both" && (
                  <div className="space-y-4 p-4 rounded-lg border border-primary/20 bg-primary/5">
                    <Label className="text-sm font-bold flex items-center gap-2"><Zap className="h-4 w-4 text-primary" /> Input + Timer (Linked)</Label>
                    <p className="text-[10px] text-muted-foreground">When input triggers → output turns ON/OFF with timer delay. Auto-reverses when input goes back.</p>

                    <div className="space-y-1"><Label className="text-[9px]">Name</Label><Input value={tName} onChange={e => setTName(e.target.value)} placeholder="Automation name" className="h-8 text-xs" /></div>

                    {/* Input trigger */}
                    <div className="flex gap-3">
                      <div className="space-y-1"><Label className="text-[9px]">When Input</Label><Select value={rInput} onValueChange={setRInput}><SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger><SelectContent>{Array.from({ length: 4 }, (_, i) => (<SelectItem key={i} value={String(i)} className="text-xs">{inName(i)}</SelectItem>))}</SelectContent></Select></div>
                      <div className="space-y-1"><Label className="text-[9px]">Goes</Label><Select value={rTrigger} onValueChange={v => setRTrigger(v as "high" | "low")}><SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="high" className="text-xs">HIGH</SelectItem><SelectItem value="low" className="text-xs">LOW</SelectItem></SelectContent></Select></div>
                    </div>

                    {/* Outputs with ON/OFF delays */}
                    <Label className="text-[9px]">Set outputs (with delays):</Label>
                    {tOutputs.length > 0 && <div className="space-y-1.5">{tOutputs.map((o, j) => {
                      const startVal = tStartWithMap[o.outputIndex] ?? true;
                      const firstLabel  = startVal ? "ON" : "OFF";
                      const firstDelay  = startVal ? o.onDelaySec : o.offDelaySec;
                      const secondLabel = startVal ? "OFF" : "ON";
                      const secondDelay = startVal ? o.offDelaySec : o.onDelaySec;
                      return (
                        <div key={j} className="flex items-center gap-2 p-2 rounded bg-muted/30 border border-border/20">
                          <span className="text-xs font-bold text-orange-400">{outName(o.outputIndex)}</span>
                          <span className="text-[9px] text-muted-foreground">Start:</span>
                          <Badge variant="outline" className={`text-[9px] ${startVal ? "text-green-400 border-green-400/30" : "text-red-400 border-red-400/30"}`}>
                            {firstLabel} {firstDelay}s
                          </Badge>
                          <span className="text-[9px] text-muted-foreground">→</span>
                          <span className="text-[9px] text-muted-foreground">→</span>
                          <Badge variant="outline" className={`text-[9px] ${!startVal ? "text-green-400 border-green-400/30" : "text-red-400 border-red-400/30"}`}>
                            {secondLabel} {secondDelay}s
                          </Badge>
                          <Button variant="ghost" size="icon" className="h-5 w-5 ml-auto hover:text-destructive" onClick={() => {
                            setTOutputs(p => p.filter((_, k) => k !== j));
                            setTStartWithMap(p => { const n = {...p}; delete n[o.outputIndex]; return n; });
                          }}><X className="h-3 w-3" /></Button>
                        </div>
                      );
                    })}</div>}

                    {/* Add output row */}
                    <div className="p-3 rounded-lg border border-border/20 bg-muted/10 space-y-2">
                      <div className="flex items-end gap-2 flex-wrap">
                        <div className="space-y-1">
                          <Label className="text-[9px]">Output</Label>
                          <Select value={tAddOut} onValueChange={setTAddOut}>
                            <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>{Array.from({ length: 15 }, (_, i) => (<SelectItem key={i} value={String(i)} className="text-xs">{outName(i)}</SelectItem>))}</SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[9px] text-blue-400">Start with</Label>
                          <Select value={tAddStart} onValueChange={setTAddStart}>
                            <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="on" className="text-xs"><span className="text-green-400 font-bold">ON</span> first</SelectItem>
                              <SelectItem value="off" className="text-xs"><span className="text-red-400 font-bold">OFF</span> first</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[9px] text-green-400">ON duration (sec)</Label>
                          <Input type="number" min={0} value={tAddOn} onChange={e => setTAddOn(e.target.value)} className="h-8 w-20 text-xs" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[9px] text-red-400">OFF duration (sec)</Label>
                          <Input type="number" min={0} value={tAddOff} onChange={e => setTAddOff(e.target.value)} className="h-8 w-20 text-xs" />
                        </div>
                        <Button variant="outline" size="sm" className="h-8 text-[10px]" onClick={() => {
                          const idx = Number(tAddOut);
                          const startVal = tAddStart === "on";
                          setTOutputs(p => [...p.filter(o => o.outputIndex !== idx), { outputIndex: idx, onDelaySec: Number(tAddOn) || 0, offDelaySec: Number(tAddOff) || 0 }]);
                          setTStartWithMap(p => ({ ...p, [idx]: startVal }));
                          setROutputs(p => [...p.filter(o => o.outputIndex !== idx), { outputIndex: idx, value: startVal }]);
                        }}><Plus className="mr-1 h-3 w-3" />Add</Button>
                      </div>
                      {/* Live preview of sequence */}
                      {(Number(tAddOn) > 0 || Number(tAddOff) > 0) && (
                        <p className="text-[9px] text-muted-foreground">
                          Sequence: {tAddStart === "on"
                            ? `→ Wait ${tAddOn}s → Stay ON until input drops`
                            : `→ Wait ${tAddOff}s → Stay OFF until input drops`}
                        </p>
                      )}
                    </div>

                    <Button size="sm" className="bg-primary hover:bg-primary/90 text-white w-full" onClick={handleSaveBoth} disabled={tOutputs.length === 0}>
                      <Save className="mr-1 h-3 w-3" /> Save Automation
                    </Button>
                  </div>
                )}
              </div>

              <DialogFooter>
                <DialogClose asChild><Button variant="outline" onClick={closePopup}><X className="mr-1 h-3 w-3" /> Cancel</Button></DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
