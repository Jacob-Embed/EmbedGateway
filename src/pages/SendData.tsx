import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Send, Trash2, Activity, TrendingUp, Pause, Play, Settings2, Zap, Square, Download, History } from "lucide-react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useTcpStream } from "@/hooks/useTcpStream";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CanBusLoaderButton } from "@/components/CanBusLoader";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

type SendMode = "normal" | "traffic" | "loader";

export default function SendData() {
  const { feed, status, sendMessage, clearFeed, activeEndpoint, rxCount } = useTcpStream();
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Mode ──
  const [sendMode, setSendMode] = useState<SendMode>("normal");

  // ── Normal mode ──
  const [inputVal, setInputVal] = useState("");
  const [encoding, setEncoding] = useState("can");
  type RxDisplay = "can" | "hex" | "dec" | "ascii" | "string";
  const loadDisplay = (key: string): RxDisplay => {
    const saved = localStorage.getItem(key) as RxDisplay | null;
    return (saved && ["can", "hex", "dec", "ascii", "string"].includes(saved)) ? saved : "dec";
  };
  const [liveDisplay, setLiveDisplay] = useState<RxDisplay>(() => loadDisplay('live.display'));
  useEffect(() => { localStorage.setItem('live.display', liveDisplay); }, [liveDisplay]);

  // ── Traffic Generator ──
  const [trafRunning, setTrafRunning] = useState(false);
  const [trafRateType, setTrafRateType] = useState<"constant" | "random">("constant");
  const [trafRateMs, setTrafRateMs] = useState("100");
  const [trafRateMin, setTrafRateMin] = useState("50");
  const [trafRateMax, setTrafRateMax] = useState("200");
  const [trafBurstType, setTrafBurstType] = useState<"constant" | "random">("constant");
  const [trafBurstSize, setTrafBurstSize] = useState("1");
  const [trafBurstMin, setTrafBurstMin] = useState("1");
  const [trafBurstMax, setTrafBurstMax] = useState("5");
  const [trafCountType, setTrafCountType] = useState<"fixed" | "continuous">("continuous");
  const [trafCountFixed, setTrafCountFixed] = useState("1000");
  const [trafIdType, setTrafIdType] = useState<"fixed" | "range" | "random">("fixed");
  const [trafIdFixed, setTrafIdFixed] = useState("100");
  const [trafIdMin, setTrafIdMin] = useState("0");
  const [trafIdMax, setTrafIdMax] = useState("7FF");
  const [trafDlc, setTrafDlc] = useState("2");
  const [trafDataType, setTrafDataType] = useState<"fixed" | "random">("fixed");
  const [trafDataFixed, setTrafDataFixed] = useState("0000");
  const [trafSentCount, setTrafSentCount] = useState(0);
  const trafTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trafRunningRef = useRef(false);

  // ── Unified Pause ──
  const [isPaused, setIsPaused] = useState(false);
  const frozenFeedRef = useRef<typeof feed>([]);

  // ── Sensor Config ──
  const getSensorColor = (index: number) => `hsl(${(index * 137.508) % 360}, 80%, 60%)`;
  const [sensorEnabled, setSensorEnabled] = useState(() => localStorage.getItem('sensor.enabled') === 'true');
  const [sensorDelimiter, setSensorDelimiter] = useState(() => localStorage.getItem('sensor.delimiter') ?? '#');
  const [bytesPerSensor, setBytesPerSensor] = useState(() => Number(localStorage.getItem('sensor.bytesPerSensor')) || 1);
  const [sensorNames, setSensorNames] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('sensor.names') ?? '[]'); } catch { return []; } });
  const [showSensorConfig, setShowSensorConfig] = useState(false);

  useEffect(() => { localStorage.setItem('sensor.enabled', String(sensorEnabled)); }, [sensorEnabled]);
  useEffect(() => { localStorage.setItem('sensor.delimiter', sensorDelimiter); }, [sensorDelimiter]);
  useEffect(() => { localStorage.setItem('sensor.bytesPerSensor', String(bytesPerSensor)); }, [bytesPerSensor]);
  useEffect(() => { localStorage.setItem('sensor.names', JSON.stringify(sensorNames)); }, [sensorNames]);

  // ── History mode ──
  type HistoryRow = { id: number; board_id: string; can_id: string; values: number[]; timestamp: string };
  const [historyMode, setHistoryMode] = useState(false);
  const [historyDays, setHistoryDays] = useState<number>(1);
  const [historyBoardId, setHistoryBoardId] = useState<string>("");
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [availableBoards, setAvailableBoards] = useState<string[]>([]);

  useEffect(() => {
    fetch("http://localhost:8000/boards").then(r => r.json()).then((rows: any[]) => {
      const ids = Array.from(new Set(rows.map(r => r.id || r.board_id).filter(Boolean))) as string[];
      setAvailableBoards(ids);
      if (ids.length && !historyBoardId) setHistoryBoardId(ids[0]);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadHistory = useCallback(async () => {
    if (!historyBoardId) { toast.error("Pick a board first"); return; }
    setHistoryLoading(true);
    try {
      const qs = new URLSearchParams({ board_id: historyBoardId, days: String(historyDays) }).toString();
      const res = await fetch(`http://localhost:8000/history/sensors?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setHistoryRows(data.rows || []);
      toast.success(`Loaded ${data.count} sensor readings (last ${historyDays}d)`);
    } catch (e: any) {
      toast.error(`Load failed: ${e.message ?? e}`);
    } finally {
      setHistoryLoading(false);
    }
  }, [historyBoardId, historyDays]);

  const downloadCsv = useCallback((kind: "sensors" | "frames" | "boardlogs") => {
    if (!historyBoardId) { toast.error("Pick a board first"); return; }
    const qs = new URLSearchParams({ board_id: historyBoardId, days: String(historyDays) }).toString();
    window.open(`http://localhost:8000/history/${kind}.csv?${qs}`, "_blank");
  }, [historyBoardId, historyDays]);

  // ── Pause freezes the feed snapshot used by graph + list ──
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isPaused) frozenFeedRef.current = [...feed]; }, [isPaused]);
  const displayFeed = isPaused ? frozenFeedRef.current : feed;

  // ── Sensor data parse ──
  const sensorActive = sensorEnabled || historyMode;  // history mode auto-enables parsing
  const { sensorPoints, sensorSeriesList, sensorCount } = useMemo(() => {
    if (!sensorActive) return { sensorPoints: [], sensorSeriesList: [], sensorCount: 0 };
    const points: Record<string, number | string>[] = [];
    let maxSensors = 0;

    const addPoint = (ts: string, bytesArr: number[]) => {
      if (!bytesArr.length) return;
      const grouped: number[] = [];
      for (let g = 0; g < bytesArr.length; g += bytesPerSensor) { let s = 0; for (let b = 0; b < bytesPerSensor && g + b < bytesArr.length; b++) s += bytesArr[g + b]; grouped.push(s); }
      maxSensors = Math.max(maxSensors, grouped.length);
      const d = new Date(ts);
      const timeLabel = historyMode
        ? `${d.toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}`
        : d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const point: Record<string, number | string> = { time: timeLabel };
      grouped.forEach((v, i) => { point[sensorNames[i] || `Sensor ${i + 1}`] = v; });
      points.push(point);
    };

    if (historyMode) {
      for (const row of historyRows) addPoint(row.timestamp, row.values || []);
    } else {
      const rxEntries = displayFeed.filter(f => f.type === 'rx');
      for (const entry of rxEntries) {
        let fullText = entry.message;
        if (entry.raw) { const b: number[] = []; for (let i = 0; i < entry.raw.length; i += 2) b.push(parseInt(entry.raw.slice(i, i + 2), 16)); fullText = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(b)); }
        for (const line of fullText.split(/[\r\n]+/).filter(l => l.trim())) {
          const di = line.indexOf(sensorDelimiter); if (di === -1) continue;
          const payload = line.slice(di + 1).trim(); if (payload.length < 2 || payload.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(payload)) continue;
          const pairs = payload.match(/.{2}/g); if (!pairs) continue;
          const raw = pairs.map(p => parseInt(p, 16)); if (raw.some(isNaN)) continue;
          addPoint(entry.timestamp, raw);
        }
      }
    }
    const sList = Array.from({ length: maxSensors }, (_, i) => ({ name: sensorNames[i] || `Sensor ${i + 1}`, color: getSensorColor(i) }));
    const sliced = historyMode ? points : points.slice(-60);
    return { sensorPoints: sliced, sensorSeriesList: sList, sensorCount: maxSensors };
  }, [displayFeed, sensorActive, sensorDelimiter, sensorNames, bytesPerSensor, historyMode, historyRows]);

  // ── Format RX ──
  const renderBytes = (bytes: number[], mode: RxDisplay): string => {
    if (mode === "hex") return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    if (mode === "dec") return bytes.map(b => String(b)).join(' ');
    if (mode === "ascii") return bytes.map(b => b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.').join('');
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  };

  const formatRx = (entry: { message: string; raw?: string }, mode: RxDisplay): string => {
    if (!entry.raw) return entry.message.trim();
    const b: number[] = []; for (let i = 0; i < entry.raw.length; i += 2) b.push(parseInt(entry.raw.slice(i, i + 2), 16));
    if (b.length === 0) return '';
    const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(b)).trim();
    const h = text.indexOf('#');
    if (h !== -1) {
      const id = text.slice(0, h), payload = text.slice(h + 1).replace(/[\r\n]/g, '');
      if (/^[0-9A-Fa-f]+$/.test(payload) && payload.length >= 2 && payload.length % 2 === 0) {
        const pairs = payload.match(/.{2}/g) || [];
        const bytes = pairs.map(p => parseInt(p, 16));
        if (mode === "can") return `${id}#${payload.toUpperCase()}`;
        return `${id}# ${renderBytes(bytes, mode)}`;
      }
    }
    return text;
  };

  useEffect(() => { if (!isPaused && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [feed, isPaused]);

  const [tick, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(id); }, []);

  const { throughput, series, hasRealData } = useMemo(() => {
    const W = 60, now = isPaused ? Math.floor(new Date(displayFeed[displayFeed.length - 1]?.timestamp ?? Date.now()).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const lbl = activeEndpoint ? (activeEndpoint.protocol === "usb-can" ? `USB:${activeEndpoint.comPort}` : `${activeEndpoint.ip}:${activeEndpoint.port}`) : "local";
    const rxE = displayFeed.filter(f => f.type === 'rx' && f.raw); const isReal = rxE.length > 0;
    const rows: Record<string, number | string>[] = [];
    for (let i = W - 1; i >= 0; i--) { const t = now - i; rows.push({ time: new Date(t * 1000).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' }), _t: t, [lbl]: 0 }); }
    if (isReal) { const m = new Map(rows.map(r => [r._t as number, r])); for (const e of rxE) { const t = Math.floor(new Date(e.timestamp).getTime() / 1000); const s = m.get(t); if (s) s[lbl] = (s[lbl] as number || 0) + e.raw!.length / 2; } }
    return { throughput: rows, series: [{ name: lbl, color: "#4ade80" }], hasRealData: isReal };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayFeed, tick, activeEndpoint, isPaused]);

  // ── Normal Send ──
  const handleDispatch = async () => {
    if (!inputVal.trim()) return;
    const raw = inputVal.trim();
    try {
      if (encoding === "can") {
        if (!raw.includes('#')) { toast.error("Must be ID#DATA"); return; }
        const [id, data] = raw.split('#', 2);
        if (!id || !data || !/^[0-9A-Fa-f]+$/.test(data)) { toast.error("DATA must be hex"); return; }
        await sendMessage(raw + "\n");
      } else if (encoding === "hex") {
        const stripped = raw.replace(/0x/gi, '').replace(/\s+/g, '');
        if (!/^[0-9A-Fa-f]*$/.test(stripped) || stripped.length % 2 !== 0) { toast.error("Invalid hex"); return; }
        const bytes: number[] = []; for (let i = 0; i < stripped.length; i += 2) bytes.push(parseInt(stripped.slice(i, i + 2), 16));
        await sendMessage(new Uint8Array(bytes), `HEX: ${bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`);
      } else if (encoding === "decimal") {
        const parts = raw.split(/[\s,]+/).filter(Boolean);
        const bytes: number[] = [];
        for (const p of parts) {
          if (!/^\d+$/.test(p)) { toast.error(`"${p}" is not a decimal byte`); return; }
          const n = parseInt(p, 10);
          if (n < 0 || n > 255) { toast.error(`${n} out of byte range (0-255)`); return; }
          bytes.push(n);
        }
        await sendMessage(new Uint8Array(bytes), `DEC: ${bytes.join(' ')}`);
      } else if (encoding === "ascii") {
        const bytes: number[] = [];
        for (const c of raw) {
          const code = c.charCodeAt(0);
          if (code > 127) { toast.error(`"${c}" is not ASCII (0-127 only)`); return; }
          bytes.push(code);
        }
        await sendMessage(new Uint8Array(bytes), `ASCII: ${raw}`);
      } else { await sendMessage(raw); }  // string (UTF-8)
      setInputVal("");
    } catch { toast.error("TX Failed"); }
  };

  // ── Traffic Generator ──
  const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randHex = (len: number) => Array.from({ length: len }, () => randInt(0, 255).toString(16).padStart(2, '0')).join('');

  const sendTrafficBurst = useCallback(async () => {
    if (!trafRunningRef.current) return;

    const burst = trafBurstType === "constant" ? Number(trafBurstSize) : randInt(Number(trafBurstMin), Number(trafBurstMax));
    const dlc = Number(trafDlc);

    for (let b = 0; b < burst; b++) {
      if (!trafRunningRef.current) return;

      // ID
      let id: string;
      if (trafIdType === "fixed") { id = trafIdFixed; }
      else if (trafIdType === "range") { id = randInt(parseInt(trafIdMin, 16), parseInt(trafIdMax, 16)).toString(16).toUpperCase(); }
      else { id = randInt(0, 0x7FF).toString(16).toUpperCase(); }

      // Data
      let data: string;
      if (trafDataType === "fixed") { data = trafDataFixed.padEnd(dlc * 2, '0').slice(0, dlc * 2); }
      else { data = randHex(dlc); }

      const frame = `${id}#${data}\n`;
      await sendMessage(frame);
      setTrafSentCount(c => c + 1);
    }

    // Check count limit
    if (trafCountType === "fixed") {
      setTrafSentCount(c => {
        if (c >= Number(trafCountFixed)) { stopTraffic(); return c; }
        return c;
      });
    }

    // Schedule next
    if (trafRunningRef.current) {
      const delay = trafRateType === "constant" ? Number(trafRateMs) : randInt(Number(trafRateMin), Number(trafRateMax));
      trafTimerRef.current = setTimeout(sendTrafficBurst, delay);
    }
  }, [trafRateType, trafRateMs, trafRateMin, trafRateMax, trafBurstType, trafBurstSize, trafBurstMin, trafBurstMax,
      trafCountType, trafCountFixed, trafIdType, trafIdFixed, trafIdMin, trafIdMax, trafDlc, trafDataType, trafDataFixed, sendMessage]);

  const startTraffic = () => {
    setTrafSentCount(0);
    trafRunningRef.current = true;
    setTrafRunning(true);
    sendTrafficBurst();
    toast.success("Traffic generator started");
  };

  const stopTraffic = () => {
    trafRunningRef.current = false;
    setTrafRunning(false);
    if (trafTimerRef.current) { clearTimeout(trafTimerRef.current); trafTimerRef.current = null; }
    toast.info("Traffic generator stopped");
  };

  useEffect(() => { return () => { trafRunningRef.current = false; if (trafTimerRef.current) clearTimeout(trafTimerRef.current); }; }, []);

  const isConnected = status.includes("Streaming") || status.includes("CONNECTED") || status.includes("ACTIVE");

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Send Data</h1>
          <p className="text-muted-foreground text-sm">Normal & traffic generator</p>
        </div>
        <div className="flex gap-2 items-center">
          <Button size="sm" variant={sendMode === "loader" ? "default" : "outline"} className="h-7 text-xs" onClick={() => setSendMode("loader")}>
            <Zap className="mr-1 h-3 w-3" /> CAN Loader
          </Button>
          <Button size="sm" variant={sendMode === "normal" ? "default" : "outline"} className="h-7 text-xs" onClick={() => setSendMode("normal")}>
            <Send className="mr-1 h-3 w-3" /> Normal
          </Button>
          <Button size="sm" variant={sendMode === "traffic" ? "default" : "outline"} className="h-7 text-xs" onClick={() => setSendMode("traffic")}>
            <Zap className="mr-1 h-3 w-3" /> Traffic
          </Button>
          <CanBusLoaderButton
            hideTrigger
            open={sendMode === "loader"}
            onOpenChange={(v) => { if (!v) setSendMode("normal"); }}
          />
        </div>
      </div>

      {/* ── Normal Mode ── */}
      {sendMode === "normal" && (
        <Card className="glass-card">
          <CardContent className="p-3">
            <div className="flex gap-3 items-end">
              <div className="w-32 shrink-0">
                <Label className="text-[9px] uppercase font-bold text-muted-foreground mb-1 block">Mode</Label>
                <Select value={encoding} onValueChange={setEncoding}>
                  <SelectTrigger className="h-8 text-[10px] font-mono"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="can" className="text-xs">CAN (ID#DATA)</SelectItem>
                    <SelectItem value="hex" className="text-xs">HEX</SelectItem>
                    <SelectItem value="decimal" className="text-xs">DECIMAL</SelectItem>
                    <SelectItem value="ascii" className="text-xs">ASCII</SelectItem>
                    <SelectItem value="string" className="text-xs">STRING</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1">
                <Label className="text-[9px] uppercase font-bold text-muted-foreground mb-1 block">Message</Label>
                <Input value={inputVal} onChange={(e) => setInputVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleDispatch(); } }}
                  placeholder={
                    encoding === "can" ? "100#0100" :
                    encoding === "hex" ? "0B 00 FF ..." :
                    encoding === "decimal" ? "11 0 255 ..." :
                    encoding === "ascii" ? "Hi! (0-127 only)" :
                    "any text..."
                  } className="h-8 text-xs font-mono" />
              </div>
              <Button onClick={handleDispatch} disabled={!inputVal.trim() || !isConnected}
                className="bg-orange-600 hover:bg-orange-500 text-white h-8 px-4 text-xs shrink-0">
                <Send className="mr-1 h-3 w-3" /> Send
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Traffic Generator ── */}
      {sendMode === "traffic" && (
        <Card className="glass-card">
          <CardHeader className="py-2 px-4 border-b border-border/20">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Zap className="h-4 w-4 text-yellow-400" /> CAN Bus Loader
              </CardTitle>
              <div className="flex items-center gap-2">
                {trafRunning && (
                  <Badge className="bg-green-500/20 text-green-400 text-[9px] font-mono animate-pulse">
                    Sent: {trafSentCount}
                  </Badge>
                )}
                {!trafRunning ? (
                  <Button size="sm" className="h-7 text-xs gap-1 bg-green-600 hover:bg-green-500" onClick={startTraffic} disabled={!isConnected}>
                    <Play className="h-3 w-3" /> Start
                  </Button>
                ) : (
                  <Button size="sm" variant="destructive" className="h-7 text-xs gap-1" onClick={stopTraffic}>
                    <Square className="h-3 w-3" /> Stop
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 space-y-4">
            {/* Rate */}
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase font-bold text-muted-foreground">Interval (ms)</Label>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Switch checked={trafRateType === "random"} onCheckedChange={v => setTrafRateType(v ? "random" : "constant")} disabled={trafRunning} />
                  <span className="text-[10px] text-muted-foreground w-14">{trafRateType === "constant" ? "Constant" : "Random"}</span>
                </div>
                {trafRateType === "constant" ? (
                  <Input value={trafRateMs} onChange={e => setTrafRateMs(e.target.value)} className="h-7 w-20 text-xs font-mono" disabled={trafRunning} />
                ) : (
                  <div className="flex items-center gap-1">
                    <Input value={trafRateMin} onChange={e => setTrafRateMin(e.target.value)} className="h-7 w-16 text-xs font-mono" disabled={trafRunning} />
                    <span className="text-[10px] text-muted-foreground">to</span>
                    <Input value={trafRateMax} onChange={e => setTrafRateMax(e.target.value)} className="h-7 w-16 text-xs font-mono" disabled={trafRunning} />
                    <span className="text-[10px] text-muted-foreground">ms</span>
                  </div>
                )}
              </div>
            </div>

            {/* Burst */}
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase font-bold text-muted-foreground">Burst Size (messages)</Label>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Switch checked={trafBurstType === "random"} onCheckedChange={v => setTrafBurstType(v ? "random" : "constant")} disabled={trafRunning} />
                  <span className="text-[10px] text-muted-foreground w-14">{trafBurstType === "constant" ? "Constant" : "Random"}</span>
                </div>
                {trafBurstType === "constant" ? (
                  <Input value={trafBurstSize} onChange={e => setTrafBurstSize(e.target.value)} className="h-7 w-20 text-xs font-mono" disabled={trafRunning} />
                ) : (
                  <div className="flex items-center gap-1">
                    <Input value={trafBurstMin} onChange={e => setTrafBurstMin(e.target.value)} className="h-7 w-16 text-xs font-mono" disabled={trafRunning} />
                    <span className="text-[10px] text-muted-foreground">to</span>
                    <Input value={trafBurstMax} onChange={e => setTrafBurstMax(e.target.value)} className="h-7 w-16 text-xs font-mono" disabled={trafRunning} />
                  </div>
                )}
              </div>
            </div>

            {/* Count */}
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase font-bold text-muted-foreground">Count</Label>
              <div className="flex items-center gap-3">
                <Select value={trafCountType} onValueChange={v => setTrafCountType(v as any)} disabled={trafRunning}>
                  <SelectTrigger className="h-7 w-32 text-[10px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="continuous" className="text-xs">Continuous</SelectItem>
                    <SelectItem value="fixed" className="text-xs">Fixed</SelectItem>
                  </SelectContent>
                </Select>
                {trafCountType === "fixed" && (
                  <Input value={trafCountFixed} onChange={e => setTrafCountFixed(e.target.value)} className="h-7 w-24 text-xs font-mono" placeholder="1000" disabled={trafRunning} />
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* ID */}
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold text-muted-foreground">CAN ID</Label>
                <Select value={trafIdType} onValueChange={v => setTrafIdType(v as any)} disabled={trafRunning}>
                  <SelectTrigger className="h-7 text-[10px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed" className="text-xs">Fixed</SelectItem>
                    <SelectItem value="range" className="text-xs">Range</SelectItem>
                    <SelectItem value="random" className="text-xs">Random (0-7FF)</SelectItem>
                  </SelectContent>
                </Select>
                {trafIdType === "fixed" && (
                  <Input value={trafIdFixed} onChange={e => setTrafIdFixed(e.target.value)} className="h-7 text-xs font-mono" placeholder="100" disabled={trafRunning} />
                )}
                {trafIdType === "range" && (
                  <div className="flex items-center gap-1">
                    <Input value={trafIdMin} onChange={e => setTrafIdMin(e.target.value)} className="h-7 w-16 text-xs font-mono" disabled={trafRunning} />
                    <span className="text-[9px] text-muted-foreground">to</span>
                    <Input value={trafIdMax} onChange={e => setTrafIdMax(e.target.value)} className="h-7 w-16 text-xs font-mono" disabled={trafRunning} />
                  </div>
                )}
              </div>

              {/* Data */}
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold text-muted-foreground">Data</Label>
                <div className="flex items-center gap-2">
                  <Select value={trafDataType} onValueChange={v => setTrafDataType(v as any)} disabled={trafRunning}>
                    <SelectTrigger className="h-7 text-[10px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed" className="text-xs">Fixed</SelectItem>
                      <SelectItem value="random" className="text-xs">Random</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="space-y-0.5">
                    <Label className="text-[9px] text-muted-foreground">DLC</Label>
                    <Input value={trafDlc} onChange={e => setTrafDlc(e.target.value)} className="h-7 w-12 text-xs font-mono" disabled={trafRunning} />
                  </div>
                </div>
                {trafDataType === "fixed" && (
                  <Input value={trafDataFixed} onChange={e => setTrafDataFixed(e.target.value)} className="h-7 text-xs font-mono" placeholder="0000" disabled={trafRunning} />
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Live Stream + RX ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <Card className="glass-card min-h-[350px] flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between py-2 px-4 border-b border-border/20">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4 text-blue-400" /> Live Stream
            </CardTitle>
            <div className="flex gap-1 items-center">
              <div className="flex rounded-md border border-border/40 overflow-hidden mr-1">
                {(["can", "hex", "dec", "ascii", "string"] as const).map(m => (
                  <Button key={m} size="sm" variant={liveDisplay === m ? "default" : "ghost"}
                    className={`h-6 rounded-none text-[10px] px-2 ${liveDisplay === m ? "bg-blue-600" : ""}`}
                    onClick={() => setLiveDisplay(m)}>{m.toUpperCase()}</Button>
                ))}
              </div>
              <Button variant="ghost" size="icon" className={`h-7 w-7 ${isPaused ? "text-green-400" : "text-yellow-400"}`}
                onClick={() => setIsPaused(p => !p)} title={isPaused ? "Resume" : "Pause"}>
                {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive" onClick={clearFeed}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              {isPaused && <Badge variant="outline" className="text-[8px] border-yellow-400/40 text-yellow-400">PAUSED</Badge>}
            </div>
          </CardHeader>
          <CardContent className="flex-1 p-0 overflow-hidden relative">
            <div ref={scrollRef} className="absolute inset-0 overflow-y-auto font-mono text-[10px] p-2 space-y-0.5 scrollbar-thin">
              {displayFeed.length === 0 ? (
                <div className="h-full flex items-center justify-center text-muted-foreground/50 italic text-xs">Waiting for data...</div>
              ) : displayFeed.map((entry, i) => (
                <div key={i} className="flex gap-2 border-b border-border/5 pb-0.5">
                  <span className="text-muted-foreground/30 text-[9px] shrink-0">{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  <span className={`text-[8px] font-black uppercase w-5 shrink-0 ${entry.type === 'tx' ? "text-orange-500" : "text-blue-400"}`}>{entry.type}</span>
                  <span className={`break-all leading-snug ${entry.type === 'tx' ? "text-orange-200" : "text-blue-200"}`}>
                    {entry.type === 'rx' ? formatRx(entry, liveDisplay) : entry.message.trim()}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
          <div className="px-3 py-1 border-t border-border/20 flex justify-between bg-muted/20">
            <span className="text-[9px] text-muted-foreground font-mono">RX: {rxCount} pkts</span>
            <span className="text-[9px] text-muted-foreground font-mono">
              {activeEndpoint ? (activeEndpoint.protocol === "usb-can" ? `USB:${activeEndpoint.comPort}` : `${activeEndpoint.ip}:${activeEndpoint.port}`) : "N/A"}
            </span>
          </div>
        </Card>

        <Card className="glass-card min-h-[350px] flex flex-col">
          <CardHeader className="py-2 px-4 border-b border-border/20">
            <CardTitle className="text-sm text-blue-400 flex items-center gap-2">
              <Activity className="h-3.5 w-3.5" /> Received [RX]
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex-1 relative overflow-hidden">
            <div className="absolute inset-0 overflow-y-auto font-mono text-[10px] p-2 space-y-0.5 bg-blue-500/5">
              {feed.filter(f => f.type === 'rx').length === 0 ? (
                <p className="text-muted-foreground/50 italic py-4 text-center text-xs">Waiting for packets...</p>
              ) : feed.filter(f => f.type === 'rx').map((f, i) => (
                <div key={i} className="text-blue-300 break-all leading-tight border-b border-border/5 pb-0.5">
                  <span className="text-[9px] opacity-30 mr-1.5">{new Date(f.timestamp).toLocaleTimeString([], { hour12: false })}</span>
                  {formatRx(f, "can")}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Graph ── */}
      <Card className="glass-card">
        <CardHeader className="flex flex-row items-center justify-between py-2 px-4 border-b border-border/20">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-green-400" />
            {sensorActive ? "Sensor Graph" : "RX Throughput"}
          </CardTitle>
          <div className="flex gap-1 items-center">
            <Button variant="ghost" size="icon" className={`h-7 w-7 ${showSensorConfig ? "text-green-400 bg-green-500/10" : "text-muted-foreground"}`}
              onClick={() => setShowSensorConfig(v => !v)}><Settings2 className="h-3.5 w-3.5" /></Button>
            <Badge variant="outline" className={`text-[9px] ${hasRealData ? "text-green-400 border-green-400/30" : "text-muted-foreground"}`}>
              <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1 ${hasRealData ? "bg-green-400 animate-pulse" : "bg-muted-foreground"}`} />
              {isPaused ? "FROZEN" : hasRealData ? "LIVE" : "IDLE"}
            </Badge>
          </div>
        </CardHeader>
        {showSensorConfig && (
          <div className="px-4 py-2 border-b border-border/20 bg-muted/50 flex items-center gap-3 flex-wrap">
            <Button variant={sensorEnabled ? "default" : "outline"} size="sm" className={`h-6 text-[10px] ${sensorEnabled ? "bg-green-600" : ""}`}
              onClick={() => setSensorEnabled(v => !v)}>Sensor: {sensorEnabled ? "ON" : "OFF"}</Button>
            <div className="flex items-center gap-1"><Label className="text-[9px]">Delim:</Label><Input value={sensorDelimiter} onChange={e => setSensorDelimiter(e.target.value)} className="h-6 w-10 text-[10px] font-mono" /></div>
            <div className="flex items-center gap-1"><Label className="text-[9px]">B/S:</Label>
              <Select value={String(bytesPerSensor)} onValueChange={v => setBytesPerSensor(Number(v))}><SelectTrigger className="h-6 w-12 text-[10px] font-mono"><SelectValue /></SelectTrigger>
                <SelectContent>{[1,2,3,4].map(n => <SelectItem key={n} value={String(n)} className="text-xs">{n}</SelectItem>)}</SelectContent></Select></div>
          </div>
        )}
        <div className="px-4 py-2 border-b border-border/20 bg-muted/30 flex items-center gap-2 flex-wrap text-[10px]">
          <div className="flex rounded-md border border-border/40 overflow-hidden">
            <Button variant={historyMode ? "ghost" : "default"} size="sm" className={`h-6 rounded-none text-[10px] px-2 ${!historyMode ? "bg-green-600" : ""}`}
              onClick={() => setHistoryMode(false)}><Activity className="h-3 w-3 mr-1" />Live</Button>
            <Button variant={historyMode ? "default" : "ghost"} size="sm" className={`h-6 rounded-none text-[10px] px-2 ${historyMode ? "bg-purple-600" : ""}`}
              onClick={() => setHistoryMode(true)}><History className="h-3 w-3 mr-1" />History</Button>
          </div>
          {!historyMode && (
            <Button variant={sensorEnabled ? "default" : "outline"} size="sm"
              className={`h-6 text-[10px] px-2 ${sensorEnabled ? "bg-emerald-600" : ""}`}
              onClick={() => setSensorEnabled(v => !v)}>
              Sensor: {sensorEnabled ? "ON" : "OFF"}
            </Button>
          )}
          {historyMode && (
            <>
              <div className="flex items-center gap-1"><Label className="text-[9px]">Board:</Label>
                <Select value={historyBoardId} onValueChange={setHistoryBoardId}>
                  <SelectTrigger className="h-6 w-32 text-[10px] font-mono"><SelectValue placeholder="pick..." /></SelectTrigger>
                  <SelectContent>{availableBoards.map(id => <SelectItem key={id} value={id} className="text-xs">{id}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1"><Label className="text-[9px]">Last:</Label>
                <Select value={String(historyDays)} onValueChange={v => setHistoryDays(Number(v))}>
                  <SelectTrigger className="h-6 w-20 text-[10px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{[1,3,5,7,14,30].map(n => <SelectItem key={n} value={String(n)} className="text-xs">{n} day{n===1?"":"s"}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <Button size="sm" variant="default" className="h-6 text-[10px] px-2" onClick={loadHistory} disabled={historyLoading}>
                {historyLoading ? "Loading..." : "Load"}
              </Button>
              <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => downloadCsv("sensors")}>
                <Download className="h-3 w-3 mr-1" />Sensors.csv
              </Button>
              <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => downloadCsv("frames")}>
                <Download className="h-3 w-3 mr-1" />Frames.csv
              </Button>
              <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => downloadCsv("boardlogs")}>
                <Download className="h-3 w-3 mr-1" />IO-Log.csv
              </Button>
              <span className="text-[9px] text-muted-foreground ml-auto">{historyRows.length} points</span>
            </>
          )}
        </div>
        <CardContent className="p-3">
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              {sensorActive && sensorPoints.length > 0 ? (
                <LineChart data={sensorPoints} margin={{ top: 5, right: 15, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="time" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 9 }} interval={Math.max(0, Math.floor(sensorPoints.length / 6) - 1)} minTickGap={50} />
                  <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 9 }} domain={[0, bytesPerSensor === 1 ? 255 : 'auto']} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 10 }} />
                  <Legend wrapperStyle={{ fontSize: 9 }} />
                  {sensorSeriesList.map(s => <Line key={s.name} type="monotone" dataKey={s.name} stroke={s.color} strokeWidth={1.5} dot={{ r: 1.5, fill: s.color, strokeWidth: 0 }} isAnimationActive={false} connectNulls />)}
                </LineChart>
              ) : (
                <LineChart data={throughput} margin={{ top: 5, right: 15, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="time" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 9 }} interval="preserveStartEnd" minTickGap={30} />
                  <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 9 }} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 10 }} />
                  {series.map(s => <Line key={s.name} type="monotone" dataKey={s.name} stroke={s.color} strokeWidth={1.5} dot={false} isAnimationActive={false} />)}
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
