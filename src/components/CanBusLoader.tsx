import { useState, useRef, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Zap, Plus, Square, Trash2, CheckCircle2 } from "lucide-react";
import { useTcpStream } from "@/hooks/useTcpStream";
import { toast } from "sonner";

/* ────────────────────────── Types ────────────────────────── */

interface LoaderInstance {
  id: number;
  name: string;
  // Rate tab
  rateType: "constant" | "random";
  rateMs: string;
  rateMin: string;
  rateMax: string;
  burstType: "constant" | "random";
  burstSize: string;
  burstMin: string;
  burstMax: string;
  // Count tab
  countType: "fixed" | "continuous";
  countFixed: string;
  // Id tab
  idMode: "random" | "scan";
  idLowest: string;
  idHighest: string;
  useExtended: boolean;   // 29-bit identifiers
  // CAN FD
  canFdEnabled: boolean;
  canFdBrs: boolean;      // Bit Rate Switch
  canFdRandomize: boolean;
  // Channel
  channel: string;
  // Data tab
  dlc: string;
  randomLength: boolean;
  dataMode: "msgNumber" | "random";
  // Runtime
  running: boolean;
  sentCount: number;
  scanCurrent: number;    // current scan ID position
}

let nextId = 1;

function createLoader(name?: string): LoaderInstance {
  const id = nextId++;
  return {
    id,
    name: name || `CAN Bus Loader ${id}`,
    rateType: "constant",
    rateMs: "1",
    rateMin: "50",
    rateMax: "200",
    burstType: "constant",
    burstSize: "1",
    burstMin: "1",
    burstMax: "5",
    countType: "fixed",
    countFixed: "1000",
    idMode: "random",
    idLowest: "0",
    idHighest: "2047",
    useExtended: false,
    canFdEnabled: false,
    canFdBrs: false,
    canFdRandomize: false,
    channel: "CAN 1",
    dlc: "8",
    randomLength: false,
    dataMode: "msgNumber",
    running: false,
    sentCount: 0,
    scanCurrent: 0,
  };
}

/* ────────────────────────── Component ────────────────────────── */

interface CanBusLoaderButtonProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}

export function CanBusLoaderButton({ open: openProp, onOpenChange, hideTrigger }: CanBusLoaderButtonProps = {}) {
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp !== undefined ? openProp : openInternal;
  const setOpen = (v: boolean) => { (onOpenChange ?? setOpenInternal)(v); };
  const [loaders, setLoaders] = useState<LoaderInstance[]>(() => [createLoader()]);
  const [activeLoader, setActiveLoader] = useState("1");
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const runningRef = useRef<Set<number>>(new Set());

  const { sendMessage, status } = useTcpStream();
  const isConnected = status.includes("Streaming") || status.includes("CONNECTED") || status.includes("ACTIVE");

  const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randHex = (len: number) => Array.from({ length: len }, () => randInt(0, 255).toString(16).padStart(2, "0")).join("");

  /* ── Loader CRUD ── */

  const addLoader = () => {
    const loader = createLoader();
    setLoaders(prev => [...prev, loader]);
    setActiveLoader(String(loader.id));
  };

  const removeLoader = (id: number) => {
    stopLoader(id);
    setLoaders(prev => {
      const next = prev.filter(l => l.id !== id);
      if (next.length === 0) {
        const fresh = createLoader();
        setActiveLoader(String(fresh.id));
        return [fresh];
      }
      if (activeLoader === String(id)) setActiveLoader(String(next[0].id));
      return next;
    });
  };

  const updateLoader = (id: number, patch: Partial<LoaderInstance>) => {
    setLoaders(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  };

  /* ── Core send logic ── */

  const sendBurst = useCallback(
    async (loader: LoaderInstance) => {
      if (!runningRef.current.has(loader.id)) return;

      const burst = loader.burstType === "constant"
        ? Number(loader.burstSize)
        : randInt(Number(loader.burstMin), Number(loader.burstMax));

      const maxDlc = Number(loader.dlc) || 8;
      const low = Number(loader.idLowest) || 0;
      const high = Number(loader.idHighest) || 2047;

      for (let b = 0; b < burst; b++) {
        if (!runningRef.current.has(loader.id)) return;

        // --- ID ---
        let canId: number;
        if (loader.idMode === "scan") {
          // Read the latest scanCurrent from state
          let currentScan = 0;
          setLoaders(prev => {
            const cur = prev.find(l => l.id === loader.id);
            currentScan = cur?.scanCurrent ?? low;
            return prev;
          });
          canId = currentScan;
          const nextScan = currentScan >= high ? low : currentScan + 1;
          setLoaders(prev => prev.map(l => l.id === loader.id ? { ...l, scanCurrent: nextScan } : l));
        } else {
          canId = randInt(low, high);
        }

        // Format ID as hex — use 8 hex digits for extended, 3 for standard
        const idHex = loader.useExtended
          ? canId.toString(16).toUpperCase().padStart(8, "0")
          : canId.toString(16).toUpperCase().padStart(3, "0");

        // --- DLC ---
        const dlc = loader.randomLength ? randInt(0, maxDlc) : maxDlc;

        // --- Data ---
        let data: string;
        if (loader.dataMode === "msgNumber") {
          // Encode the sent count as data bytes (big endian counter)
          let count = 0;
          setLoaders(prev => {
            const cur = prev.find(l => l.id === loader.id);
            count = cur?.sentCount ?? 0;
            return prev;
          });
          const hex = count.toString(16).toUpperCase().padStart(dlc * 2, "0");
          data = hex.slice(-(dlc * 2));
        } else {
          data = randHex(dlc);
        }

        // --- CAN FD flags ---
        let flags = "";
        if (loader.canFdEnabled) {
          if (loader.canFdRandomize) {
            const fd = Math.random() > 0.5;
            const brs = fd && Math.random() > 0.5;
            flags = fd ? (brs ? " [FD+BRS]" : " [FD]") : "";
          } else {
            flags = loader.canFdBrs ? " [FD+BRS]" : " [FD]";
          }
        }

        const frame = `${idHex}#${data}${flags}\n`;
        await sendMessage(frame);
        setLoaders(prev => prev.map(l => l.id === loader.id ? { ...l, sentCount: l.sentCount + 1 } : l));
      }

      // Check count limit
      if (loader.countType === "fixed") {
        let shouldStop = false;
        setLoaders(prev => {
          const cur = prev.find(l => l.id === loader.id);
          if (cur && cur.sentCount >= Number(loader.countFixed)) shouldStop = true;
          return prev;
        });
        if (shouldStop) { stopLoader(loader.id); return; }
      }

      // Schedule next burst
      if (runningRef.current.has(loader.id)) {
        setLoaders(prev => {
          const cur = prev.find(l => l.id === loader.id);
          if (!cur) return prev;
          const delay = cur.rateType === "constant"
            ? Number(cur.rateMs)
            : randInt(Number(cur.rateMin), Number(cur.rateMax));
          const timer = setTimeout(() => {
            setLoaders(latest => {
              const latestLoader = latest.find(l => l.id === loader.id);
              if (latestLoader && runningRef.current.has(loader.id)) sendBurst(latestLoader);
              return latest;
            });
          }, Math.max(1, delay));
          timersRef.current.set(loader.id, timer);
          return prev;
        });
      }
    },
    [sendMessage]
  );

  const startLoader = (id: number) => {
    setLoaders(prev =>
      prev.map(l => {
        if (l.id !== id) return l;
        const low = Number(l.idLowest) || 0;
        runningRef.current.add(id);
        const updated = { ...l, running: true, sentCount: 0, scanCurrent: low };
        setTimeout(() => sendBurst(updated), 0);
        toast.success(`${l.name} started`);
        return updated;
      })
    );
  };

  const stopLoader = (id: number) => {
    runningRef.current.delete(id);
    const timer = timersRef.current.get(id);
    if (timer) { clearTimeout(timer); timersRef.current.delete(id); }
    setLoaders(prev =>
      prev.map(l => {
        if (l.id !== id) return l;
        if (l.running) toast.info(`${l.name} stopped — ${l.sentCount} sent`);
        return { ...l, running: false };
      })
    );
  };

  // Cleanup
  useEffect(() => {
    return () => {
      runningRef.current.clear();
      timersRef.current.forEach(t => clearTimeout(t));
      timersRef.current.clear();
    };
  }, []);

  const anyRunning = loaders.some(l => l.running);

  /* ────────────────────────── Render ────────────────────────── */

  return (
    <>
      {/* Trigger Button */}
      {!hideTrigger && (
        <Button
          onClick={() => setOpen(true)}
          variant={open ? "default" : "outline"}
          size="sm"
          className={`h-7 gap-1.5 text-xs font-mono ${anyRunning ? "border-yellow-400/50 text-yellow-400 bg-yellow-500/10 animate-pulse" : ""}`}
        >
          <Zap className="h-3.5 w-3.5" />
          CAN Loader
          {anyRunning && (
            <Badge className="bg-green-500/20 text-green-400 text-[8px] ml-1 px-1">
              {loaders.filter(l => l.running).length} active
            </Badge>
          )}
        </Button>
      )}

      {/* Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-hidden flex flex-col p-0">

          {/* ── Loader instance tabs (top bar) ── */}
          <div className="flex items-center gap-2 pl-4 pr-10 pt-4 pb-2 border-b border-border/30">
            <Zap className="h-4 w-4 text-yellow-400 shrink-0" />
            <div className="flex items-center gap-1 flex-1 overflow-x-auto">
              {loaders.map(l => (
                <Button
                  key={l.id}
                  variant={activeLoader === String(l.id) ? "default" : "ghost"}
                  size="sm"
                  className={`h-7 text-[10px] px-2.5 gap-1.5 shrink-0 ${activeLoader === String(l.id) ? "bg-primary" : ""}`}
                  onClick={() => setActiveLoader(String(l.id))}
                >
                  {l.running && <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />}
                  {l.name}
                </Button>
              ))}
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={addLoader} title="Add new loader">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* ── Per-loader content ── */}
          {loaders.map(loader => {
            if (String(loader.id) !== activeLoader) return null;
            const disabled = loader.running;

            return (
              <div key={loader.id} className="flex-1 overflow-hidden flex flex-col">
                {/* Loader name row */}
                <div className="flex items-center gap-2 px-4 pt-2">
                  <Input
                    value={loader.name}
                    onChange={e => updateLoader(loader.id, { name: e.target.value })}
                    className="h-7 text-xs font-mono flex-1"
                    disabled={disabled}
                  />
                  {loaders.length > 1 && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive shrink-0" onClick={() => removeLoader(loader.id)} disabled={disabled}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>

                {/* ── Inner tabs: Rate | Count | Id | Data | Options ── */}
                <Tabs defaultValue="rate" className="flex-1 overflow-hidden flex flex-col px-4 pt-2">
                  <TabsList className="h-8 w-full bg-muted/50 grid grid-cols-5">
                    <TabsTrigger value="rate" className="text-[11px] h-6">Rate</TabsTrigger>
                    <TabsTrigger value="count" className="text-[11px] h-6">Count</TabsTrigger>
                    <TabsTrigger value="id" className="text-[11px] h-6">Id</TabsTrigger>
                    <TabsTrigger value="data" className="text-[11px] h-6">Data</TabsTrigger>
                    <TabsTrigger value="options" className="text-[11px] h-6">Options</TabsTrigger>
                  </TabsList>

                  {/* ───── RATE TAB ───── */}
                  <TabsContent value="rate" className="overflow-y-auto flex-1 mt-3 space-y-4 pb-2">
                    {/* Interval */}
                    <fieldset className="space-y-2 p-3 rounded-lg border border-border/30 bg-muted/10">
                      <legend className="text-[10px] uppercase font-bold text-muted-foreground px-1">Interval (ms)</legend>
                      <RadioGroup
                        value={loader.rateType}
                        onValueChange={v => updateLoader(loader.id, { rateType: v as "constant" | "random" })}
                        disabled={disabled}
                        className="gap-3"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="constant" id={`rate-const-${loader.id}`} />
                            <Label htmlFor={`rate-const-${loader.id}`} className="text-xs">Constant</Label>
                          </div>
                          <Input
                            value={loader.rateMs}
                            onChange={e => updateLoader(loader.id, { rateMs: e.target.value })}
                            className="h-7 w-20 text-xs font-mono"
                            disabled={disabled || loader.rateType !== "constant"}
                          />
                          <span className="text-[10px] text-muted-foreground">ms</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="random" id={`rate-rand-${loader.id}`} />
                            <Label htmlFor={`rate-rand-${loader.id}`} className="text-xs">Random</Label>
                          </div>
                          <Input
                            value={loader.rateMin}
                            onChange={e => updateLoader(loader.id, { rateMin: e.target.value })}
                            className="h-7 w-16 text-xs font-mono"
                            disabled={disabled || loader.rateType !== "random"}
                          />
                          <span className="text-[10px] text-muted-foreground">to</span>
                          <Input
                            value={loader.rateMax}
                            onChange={e => updateLoader(loader.id, { rateMax: e.target.value })}
                            className="h-7 w-16 text-xs font-mono"
                            disabled={disabled || loader.rateType !== "random"}
                          />
                          <span className="text-[10px] text-muted-foreground">ms</span>
                        </div>
                      </RadioGroup>
                    </fieldset>

                    {/* Burst size */}
                    <fieldset className="space-y-2 p-3 rounded-lg border border-border/30 bg-muted/10">
                      <legend className="text-[10px] uppercase font-bold text-muted-foreground px-1">Burst size (messages)</legend>
                      <RadioGroup
                        value={loader.burstType}
                        onValueChange={v => updateLoader(loader.id, { burstType: v as "constant" | "random" })}
                        disabled={disabled}
                        className="gap-3"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="constant" id={`burst-const-${loader.id}`} />
                            <Label htmlFor={`burst-const-${loader.id}`} className="text-xs">Constant</Label>
                          </div>
                          <Input
                            value={loader.burstSize}
                            onChange={e => updateLoader(loader.id, { burstSize: e.target.value })}
                            className="h-7 w-20 text-xs font-mono"
                            disabled={disabled || loader.burstType !== "constant"}
                          />
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="random" id={`burst-rand-${loader.id}`} />
                            <Label htmlFor={`burst-rand-${loader.id}`} className="text-xs">Random</Label>
                          </div>
                          <Input
                            value={loader.burstMin}
                            onChange={e => updateLoader(loader.id, { burstMin: e.target.value })}
                            className="h-7 w-14 text-xs font-mono"
                            disabled={disabled || loader.burstType !== "random"}
                          />
                          <span className="text-[10px] text-muted-foreground">to</span>
                          <Input
                            value={loader.burstMax}
                            onChange={e => updateLoader(loader.id, { burstMax: e.target.value })}
                            className="h-7 w-14 text-xs font-mono"
                            disabled={disabled || loader.burstType !== "random"}
                          />
                        </div>
                      </RadioGroup>
                    </fieldset>
                  </TabsContent>

                  {/* ───── COUNT TAB ───── */}
                  <TabsContent value="count" className="overflow-y-auto flex-1 mt-3 pb-2">
                    <fieldset className="space-y-3 p-3 rounded-lg border border-border/30 bg-muted/10">
                      <legend className="text-[10px] uppercase font-bold text-muted-foreground px-1">Number of messages</legend>
                      <RadioGroup
                        value={loader.countType}
                        onValueChange={v => updateLoader(loader.id, { countType: v as "fixed" | "continuous" })}
                        disabled={disabled}
                        className="gap-3"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="fixed" id={`count-fixed-${loader.id}`} />
                            <Label htmlFor={`count-fixed-${loader.id}`} className="text-xs">Fixed to</Label>
                          </div>
                          <Input
                            value={loader.countFixed}
                            onChange={e => updateLoader(loader.id, { countFixed: e.target.value })}
                            className="h-7 w-24 text-xs font-mono"
                            disabled={disabled || loader.countType !== "fixed"}
                          />
                          <span className="text-[10px] text-muted-foreground">message(s)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="continuous" id={`count-cont-${loader.id}`} />
                          <Label htmlFor={`count-cont-${loader.id}`} className="text-xs">Continuous transmission</Label>
                        </div>
                      </RadioGroup>
                    </fieldset>
                  </TabsContent>

                  {/* ───── ID TAB ───── */}
                  <TabsContent value="id" className="overflow-y-auto flex-1 mt-3 space-y-4 pb-2">
                    {/* CAN Identifier */}
                    <fieldset className="space-y-3 p-3 rounded-lg border border-border/30 bg-muted/10">
                      <legend className="text-[10px] uppercase font-bold text-muted-foreground px-1">CAN Identifier</legend>
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                          <Label className="text-xs text-muted-foreground">Lowest:</Label>
                          <Input
                            value={loader.idLowest}
                            onChange={e => updateLoader(loader.id, { idLowest: e.target.value })}
                            className="h-7 w-20 text-xs font-mono"
                            disabled={disabled}
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <Label className="text-xs text-muted-foreground">Highest:</Label>
                          <Input
                            value={loader.idHighest}
                            onChange={e => updateLoader(loader.id, { idHighest: e.target.value })}
                            className="h-7 w-20 text-xs font-mono"
                            disabled={disabled}
                          />
                        </div>
                      </div>

                      <RadioGroup
                        value={loader.idMode}
                        onValueChange={v => updateLoader(loader.id, { idMode: v as "random" | "scan" })}
                        disabled={disabled}
                        className="gap-2"
                      >
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="random" id={`id-rand-${loader.id}`} />
                          <Label htmlFor={`id-rand-${loader.id}`} className="text-xs">Random</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="scan" id={`id-scan-${loader.id}`} />
                          <Label htmlFor={`id-scan-${loader.id}`} className="text-xs">Scan from Lowest to Highest</Label>
                        </div>
                      </RadioGroup>

                      <div className="flex items-center gap-2 pt-1">
                        <Checkbox
                          id={`ext-${loader.id}`}
                          checked={loader.useExtended}
                          onCheckedChange={v => updateLoader(loader.id, { useExtended: !!v })}
                          disabled={disabled}
                        />
                        <Label htmlFor={`ext-${loader.id}`} className="text-xs">Use extended (29-bit) identifiers</Label>
                      </div>
                    </fieldset>

                    {/* CAN FD */}
                    <fieldset className="space-y-2 p-3 rounded-lg border border-border/30 bg-muted/10">
                      <legend className="text-[10px] uppercase font-bold text-muted-foreground px-1">CAN FD</legend>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`fd-${loader.id}`}
                          checked={loader.canFdEnabled}
                          onCheckedChange={v => updateLoader(loader.id, { canFdEnabled: !!v })}
                          disabled={disabled}
                        />
                        <Label htmlFor={`fd-${loader.id}`} className="text-xs">FDF - Use Flexible Data Rate Format</Label>
                      </div>
                      <div className="flex items-center gap-2 pl-6">
                        <Checkbox
                          id={`brs-${loader.id}`}
                          checked={loader.canFdBrs}
                          onCheckedChange={v => updateLoader(loader.id, { canFdBrs: !!v })}
                          disabled={disabled || !loader.canFdEnabled}
                        />
                        <Label htmlFor={`brs-${loader.id}`} className={`text-xs ${!loader.canFdEnabled ? "opacity-40" : ""}`}>BRS - Use Bit Rate Switch</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`fdrand-${loader.id}`}
                          checked={loader.canFdRandomize}
                          onCheckedChange={v => updateLoader(loader.id, { canFdRandomize: !!v })}
                          disabled={disabled}
                        />
                        <Label htmlFor={`fdrand-${loader.id}`} className="text-xs">Randomize CAN FD flags</Label>
                      </div>
                    </fieldset>

                    {/* Channel */}
                    <div className="flex items-center gap-3">
                      <Label className="text-xs text-muted-foreground">Channel:</Label>
                      <Select value={loader.channel} onValueChange={v => updateLoader(loader.id, { channel: v })} disabled={disabled}>
                        <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="CAN 1" className="text-xs">CAN 1</SelectItem>
                          <SelectItem value="CAN 2" className="text-xs">CAN 2</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </TabsContent>

                  {/* ───── DATA TAB ───── */}
                  <TabsContent value="data" className="overflow-y-auto flex-1 mt-3 pb-2">
                    <fieldset className="space-y-3 p-3 rounded-lg border border-border/30 bg-muted/10">
                      <legend className="text-[10px] uppercase font-bold text-muted-foreground px-1">Message Contents</legend>

                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                          <Label className="text-xs text-muted-foreground">Length:</Label>
                          <Select value={loader.dlc} onValueChange={v => updateLoader(loader.id, { dlc: v })} disabled={disabled}>
                            <SelectTrigger className="h-7 w-16 text-xs font-mono"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {[0,1,2,3,4,5,6,7,8,12,16,20,24,32,48,64].map(n => (
                                <SelectItem key={n} value={String(n)} className="text-xs font-mono">{n}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`rlen-${loader.id}`}
                            checked={loader.randomLength}
                            onCheckedChange={v => updateLoader(loader.id, { randomLength: !!v })}
                            disabled={disabled}
                          />
                          <Label htmlFor={`rlen-${loader.id}`} className="text-xs">Random length</Label>
                        </div>
                      </div>

                      <RadioGroup
                        value={loader.dataMode}
                        onValueChange={v => updateLoader(loader.id, { dataMode: v as "msgNumber" | "random" })}
                        disabled={disabled}
                        className="gap-2 pt-1"
                      >
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="msgNumber" id={`data-num-${loader.id}`} />
                          <Label htmlFor={`data-num-${loader.id}`} className="text-xs">Message number in data part</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="random" id={`data-rand-${loader.id}`} />
                          <Label htmlFor={`data-rand-${loader.id}`} className="text-xs">Random data</Label>
                        </div>
                      </RadioGroup>
                    </fieldset>
                  </TabsContent>

                  {/* ───── OPTIONS TAB ───── */}
                  <TabsContent value="options" className="overflow-y-auto flex-1 mt-3 pb-2">
                    <div className="space-y-4">
                      <fieldset className="space-y-3 p-3 rounded-lg border border-border/30 bg-muted/10">
                        <legend className="text-[10px] uppercase font-bold text-muted-foreground px-1">Status</legend>
                        <div className="space-y-2 text-xs">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">State:</span>
                            <Badge variant="outline" className={`text-[10px] ${loader.running ? "border-green-400/30 text-green-400" : "border-muted-foreground/30"}`}>
                              {loader.running ? "Running" : "Stopped"}
                            </Badge>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Messages sent:</span>
                            <span className="font-mono">{loader.sentCount.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">ID Mode:</span>
                            <span className="font-mono">{loader.idMode === "scan" ? `Scan (${loader.idLowest}→${loader.idHighest})` : "Random"}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Data Mode:</span>
                            <span className="font-mono">{loader.dataMode === "msgNumber" ? "Msg Counter" : "Random"}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">CAN FD:</span>
                            <span className="font-mono">{loader.canFdEnabled ? (loader.canFdBrs ? "FD + BRS" : "FD") : "Classic"}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Extended ID:</span>
                            <span className="font-mono">{loader.useExtended ? "29-bit" : "11-bit"}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Channel:</span>
                            <span className="font-mono">{loader.channel}</span>
                          </div>
                        </div>
                      </fieldset>

                      <fieldset className="space-y-3 p-3 rounded-lg border border-border/30 bg-muted/10">
                        <legend className="text-[10px] uppercase font-bold text-muted-foreground px-1">Frame Preview</legend>
                        <code className="text-[11px] font-mono text-primary break-all block">
                          {(() => {
                            const idHex = loader.useExtended ? "1ABCDEF0" : loader.idMode === "scan" ? Number(loader.idLowest).toString(16).toUpperCase().padStart(3, "0") : "XXX";
                            const dlc = Number(loader.dlc) || 8;
                            const data = loader.dataMode === "msgNumber" ? "0".repeat(dlc * 2) : "XX".repeat(dlc);
                            const fd = loader.canFdEnabled ? (loader.canFdBrs ? " [FD+BRS]" : " [FD]") : "";
                            return `${idHex}#${data}${fd}`;
                          })()}
                        </code>
                        <p className="text-[9px] text-muted-foreground">
                          Example frame that will be generated. XX = random bytes.
                        </p>
                      </fieldset>
                    </div>
                  </TabsContent>
                </Tabs>

                {/* Running status bar */}
                {loader.running && (
                  <div className="flex items-center gap-2 mx-4 mb-1 p-2 rounded-lg bg-green-500/10 border border-green-500/20">
                    <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-[10px] text-green-400 font-mono flex-1">
                      Running — Sent: {loader.sentCount.toLocaleString()}
                      {loader.countType === "fixed" && ` / ${Number(loader.countFixed).toLocaleString()}`}
                    </span>
                    {loader.countType === "fixed" && (
                      <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-green-400 rounded-full transition-all"
                          style={{ width: `${Math.min(100, (loader.sentCount / Number(loader.countFixed)) * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Footer: Start / Stop */}
                <div className="flex items-center justify-between px-4 py-3 border-t border-border/30 bg-muted/10">
                  <div className="text-[10px] text-muted-foreground font-mono">
                    {loader.running
                      ? `${loader.sentCount.toLocaleString()} sent`
                      : isConnected ? "Ready" : "Connect first"}
                  </div>
                  <div className="flex gap-2">
                    {!loader.running ? (
                      <Button size="sm" className="h-8 text-xs gap-1.5 bg-green-600 hover:bg-green-500" onClick={() => startLoader(loader.id)} disabled={!isConnected}>
                        <CheckCircle2 className="h-3.5 w-3.5" /> Start
                      </Button>
                    ) : (
                      <Button size="sm" variant="destructive" className="h-8 text-xs gap-1.5" onClick={() => stopLoader(loader.id)}>
                        <Square className="h-3.5 w-3.5" /> Stop
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </DialogContent>
      </Dialog>
    </>
  );
}
