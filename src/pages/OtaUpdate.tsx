import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  FolderOpen,
  Pause,
  Play,
  Plug,
  Save,
  Square,
  Trash2,
  UploadCloud,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useTcpStream } from "@/hooks/useTcpStream";
import { useBoards } from "@/contexts/BoardContext";

/**
 * OTA Firmware Update — wired to real fleet state, no simulation.
 *
 *   - Connection state mirrors the rest of the dashboard (BRIDGE_CONNECTED/ACTIVE/Streaming).
 *   - Target list comes from BoardContext (only `status === "online"` boards show up).
 *   - Firmware validation runs in the browser: size cap, Cortex-M vector-table
 *     sanity (initial SP into SRAM, reset handler into flash), CRC16 for reference.
 *   - Start OTA POSTs to the backend's `/ota/start` and subscribes to `/ws/ota` for progress.
 *     If the endpoint isn't deployed yet the user gets a clear error, no fake progress.
 */

// ────────────────────────────────────────────────────────────────────────────
// Constants — STM32H7 vector-table sanity ranges
// ────────────────────────────────────────────────────────────────────────────

// Initial SP (offset 0x00) must point into one of the H7 SRAM regions:
//   DTCM/AXI base bank   0x2000_0000 – 0x2007_FFFF
//   AXI SRAM             0x2400_0000 – 0x2407_FFFF
//   SRAM1..3             0x3000_0000 – 0x3004_7FFF
//   SRAM4 (D3 domain)    0x3800_0000 – 0x3800_FFFF
// We accept the broader 0x2000_0000 – 0x3FFF_FFFF window so the check tracks
// every H7 variant without needing per-part tables.
const SRAM_MIN = 0x20000000;
const SRAM_MAX = 0x3FFFFFFF;

// Reset handler (offset 0x04) must point into the device flash window. H7
// internal flash maps to 0x0800_0000 – 0x081F_FFFF (max 2 MiB). The reset-
// vector value is Thumb-encoded — bit 0 is set; mask it before checking.
const FLASH_MIN = 0x08000000;
const FLASH_MAX = 0x081FFFFF;

const MAX_FW_SIZE = 236 * 1024;       // OTA slot cap, override here if your fleet uses a different size
const DATA_BYTES_PER_CHUNK = 6;
const DEFAULT_FPS = 3200;

const BACKEND_BASE = "http://localhost:8000";
const OTA_WS_URL = "ws://localhost:8000/ws/ota";

type Phase =
  | "IDLE" | "INIT_STEP1" | "REBOOT_WAIT" | "INIT_STEP2"
  | "STARTING" | "STREAMING" | "PAUSED" | "ENDING"
  | "VERIFYING" | "APPLYING" | "COMPLETE" | "ABORTED";

type ApplyStatus = "PENDING" | "APPLIED" | "SKIPPED" | "ABORTED";
type LogLevel = "INFO" | "WARN" | "ERROR";
type TargetMode = "all" | "selected" | "single";

interface BoardOtaRow {
  nodeId: string;
  readyStep1: boolean;
  readyStep2: boolean;
  chunksReceived: number;
  retransmits: number;
  crcMatch: boolean | null;
  applyStatus: ApplyStatus;
}

interface LogEntry { ts: string; level: LogLevel; msg: string; }

const PHASE_LABEL: Record<Phase, string> = {
  IDLE: "Idle",
  INIT_STEP1: "INIT step 1 (application)…",
  REBOOT_WAIT: "Waiting for boards to reboot…",
  INIT_STEP2: "INIT step 2 (bootloader)…",
  STARTING: "Starting…",
  STREAMING: "Streaming data…",
  PAUSED: "Paused",
  ENDING: "Finalising…",
  VERIFYING: "Verifying CRC…",
  APPLYING: "Applying & rebooting…",
  COMPLETE: "Complete",
  ABORTED: "Aborted",
};

const PHASE_COLOR: Record<Phase, string> = {
  IDLE:        "text-muted-foreground",
  INIT_STEP1:  "text-blue-400",
  REBOOT_WAIT: "text-blue-400",
  INIT_STEP2:  "text-blue-400",
  STARTING:    "text-cyan-400",
  STREAMING:   "text-purple-400",
  PAUSED:      "text-amber-400",
  ENDING:      "text-cyan-400",
  VERIFYING:   "text-sky-400",
  APPLYING:    "text-emerald-400",
  COMPLETE:    "text-emerald-400",
  ABORTED:     "text-red-400",
};

const LOG_COLOR: Record<LogLevel, string> = {
  INFO:  "text-foreground/80",
  WARN:  "text-amber-400",
  ERROR: "text-red-400",
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * CRC-16-CCITT (poly 0x1021, init **0xFFFF**) — matches the bootloader's
 * BL_Crc16() and backend `crc16_ccitt`. Same value the device computes over
 * the received image, so the displayed CRC here matches the VERIFY exchange.
 */
function crc16Ccitt(buf: Uint8Array): number {
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= (buf[i] << 8) & 0xFFFF;
    for (let k = 0; k < 8; k++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

function ts(): string {
  return new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Convert a 32-bit little-endian ELF (ARM Cortex-M) into a flat firmware image.
 *
 * Walks PT_LOAD program headers, sorts by physical address, concatenates them
 * into a single Uint8Array starting at the lowest p_paddr with 0xFF padding
 * across inter-segment gaps. Mirrors what `ota_tool/firmware/loader.py` does
 * server-side, so an ELF that converts here will produce the same .bin there.
 */
function parseElf(buf: Uint8Array): { data: Uint8Array; baseAddr: number } {
  if (buf.length < 52) throw new Error("ELF too short for a 32-bit header");
  if (buf[0] !== 0x7F || buf[1] !== 0x45 || buf[2] !== 0x4C || buf[3] !== 0x46) {
    throw new Error("not an ELF file (bad magic)");
  }
  if (buf[4] !== 1) throw new Error("ELF must be 32-bit (EI_CLASS=1)");
  if (buf[5] !== 1) throw new Error("ELF must be little-endian (EI_DATA=1)");

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const e_phoff     = dv.getUint32(0x1C, true);
  const e_phentsize = dv.getUint16(0x2A, true);
  const e_phnum     = dv.getUint16(0x2C, true);
  if (e_phentsize !== 32) throw new Error(`unexpected program header size ${e_phentsize}`);
  if (e_phnum === 0) throw new Error("ELF has no program headers");

  const PT_LOAD = 1;
  const segments: { paddr: number; data: Uint8Array }[] = [];
  for (let i = 0; i < e_phnum; i++) {
    const off = e_phoff + i * e_phentsize;
    if (off + 32 > buf.length) throw new Error("program header table truncated");
    const p_type   = dv.getUint32(off + 0x00, true);
    if (p_type !== PT_LOAD) continue;
    const p_offset = dv.getUint32(off + 0x04, true);
    const p_paddr  = dv.getUint32(off + 0x0C, true);
    const p_filesz = dv.getUint32(off + 0x10, true);
    if (p_filesz === 0) continue; // bss-only, no bytes to flash
    if (p_offset + p_filesz > buf.length) {
      throw new Error(`PT_LOAD segment ${i} extends past file end`);
    }
    segments.push({ paddr: p_paddr, data: buf.slice(p_offset, p_offset + p_filesz) });
  }
  if (segments.length === 0) throw new Error("no PT_LOAD segments with file data");

  segments.sort((a, b) => a.paddr - b.paddr);
  const baseAddr = segments[0].paddr;
  const lastSeg = segments[segments.length - 1];
  const totalLen = (lastSeg.paddr + lastSeg.data.length) - baseAddr;

  if (totalLen > 4 * 1024 * 1024) {
    throw new Error(`ELF segments span ${totalLen} bytes — refusing to allocate that much padding`);
  }
  const out = new Uint8Array(totalLen).fill(0xFF);
  for (const seg of segments) {
    out.set(seg.data, seg.paddr - baseAddr);
  }
  return { data: out, baseAddr };
}

/**
 * Parse Intel HEX into a flat image with FF-filled gaps.
 *
 * Supports record types: 00 (data), 01 (EOF), 02 (extended segment), 03
 * (start segment, ignored), 04 (extended linear), 05 (start linear, ignored).
 * Validates every record's checksum.
 */
function parseHex(text: string): { data: Uint8Array; baseAddr: number } {
  const records: { addr: number; data: Uint8Array }[] = [];
  let upperLinear = 0;
  let upperSeg = 0;
  let sawEof = false;
  let lineNo = 0;

  for (const raw of text.split(/\r?\n/)) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== ":") throw new Error(`line ${lineNo}: missing ':' start`);
    if (line.length < 11 || (line.length - 1) % 2 !== 0) {
      throw new Error(`line ${lineNo}: malformed length`);
    }
    const bytes: number[] = [];
    for (let i = 1; i < line.length; i += 2) {
      const b = parseInt(line.slice(i, i + 2), 16);
      if (Number.isNaN(b)) throw new Error(`line ${lineNo}: invalid hex chars`);
      bytes.push(b);
    }
    const length = bytes[0];
    if (bytes.length !== 5 + length) {
      throw new Error(`line ${lineNo}: length mismatch (declared ${length}, got ${bytes.length - 5} data bytes)`);
    }
    let sum = 0;
    for (let i = 0; i < bytes.length - 1; i++) sum = (sum + bytes[i]) & 0xFF;
    const expected = ((-sum) & 0xFF);
    if (expected !== bytes[bytes.length - 1]) {
      throw new Error(`line ${lineNo}: checksum mismatch (got 0x${bytes[bytes.length - 1].toString(16)}, want 0x${expected.toString(16)})`);
    }

    const recAddr = (bytes[1] << 8) | bytes[2];
    const recType = bytes[3];
    const data = bytes.slice(4, 4 + length);

    if (recType === 0x00) {
      const fullAddr = (upperLinear << 16) | (upperSeg << 4) | recAddr;
      records.push({ addr: fullAddr >>> 0, data: new Uint8Array(data) });
    } else if (recType === 0x01) {
      sawEof = true;
      break;
    } else if (recType === 0x02) {
      if (length !== 2) throw new Error(`line ${lineNo}: ext-segment record must carry 2 bytes`);
      upperSeg = (data[0] << 8) | data[1];
      upperLinear = 0;
    } else if (recType === 0x04) {
      if (length !== 2) throw new Error(`line ${lineNo}: ext-linear record must carry 2 bytes`);
      upperLinear = (data[0] << 8) | data[1];
      upperSeg = 0;
    } else if (recType === 0x03 || recType === 0x05) {
      // Start-segment / start-linear — entry-point hints, irrelevant for flashing.
    } else {
      throw new Error(`line ${lineNo}: unknown record type 0x${recType.toString(16)}`);
    }
  }
  if (!sawEof) throw new Error("no EOF (:00000001FF) record found");
  if (records.length === 0) throw new Error("no data records found");

  records.sort((a, b) => a.addr - b.addr);
  const baseAddr = records[0].addr;
  let lastEnd = 0;
  for (const r of records) lastEnd = Math.max(lastEnd, r.addr + r.data.length);
  const totalLen = lastEnd - baseAddr;
  if (totalLen > 4 * 1024 * 1024) {
    throw new Error(`HEX records span ${totalLen} bytes — refusing to allocate that much padding`);
  }

  const out = new Uint8Array(totalLen).fill(0xFF);
  for (const r of records) out.set(r.data, r.addr - baseAddr);
  return { data: out, baseAddr };
}

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────

export default function OtaUpdate() {
  // ── Live connection state — same logic the rest of the dashboard uses ───
  const { status: tcpStatus, activeEndpoint } = useTcpStream();
  const isConnected = useMemo(
    () =>
      !!activeEndpoint &&
      (tcpStatus.includes("Streaming") ||
        tcpStatus.includes("BRIDGE_CONNECTED") ||
        tcpStatus.includes("CONNECTED") ||
        tcpStatus.includes("ACTIVE")),
    [tcpStatus, activeEndpoint],
  );
  const endpointLabel = activeEndpoint
    ? activeEndpoint.protocol === "usb-can"
      ? `USB:${activeEndpoint.comPort}`
      : `${activeEndpoint.ip}:${activeEndpoint.port}`
    : "";

  // ── Real fleet — only online boards are valid OTA targets ───────────────
  const { boards } = useBoards();
  const onlineBoards = useMemo(
    () => boards.filter((b) => b.status === "online").map((b) => b.id),
    [boards],
  );

  // ── Firmware ────────────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fwName, setFwName] = useState("");
  const [fwBytes, setFwBytes] = useState<Uint8Array | null>(null);
  const [fwCrc, setFwCrc] = useState<number | null>(null);
  const [fwInitialSp, setFwInitialSp] = useState<number | null>(null);
  const [fwResetHandler, setFwResetHandler] = useState<number | null>(null);
  const [fwError, setFwError] = useState<string>("");
  const [convertedFrom, setConvertedFrom] = useState<"" | "ELF" | "HEX">("");

  // ── Target selection ────────────────────────────────────────────────────
  const [targetMode, setTargetMode] = useState<TargetMode>("all");
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [singleTarget, setSingleTarget] = useState<string>("");

  // Keep `singleTarget` valid as the fleet changes; drop missing IDs from `selectedTargets`.
  useEffect(() => {
    if (onlineBoards.length === 0) {
      if (singleTarget !== "") setSingleTarget("");
      if (selectedTargets.size > 0) setSelectedTargets(new Set());
      return;
    }
    if (!onlineBoards.includes(singleTarget)) setSingleTarget(onlineBoards[0]);
    let pruned = false;
    const next = new Set<string>();
    for (const id of selectedTargets) {
      if (onlineBoards.includes(id)) next.add(id);
      else pruned = true;
    }
    if (pruned) setSelectedTargets(next);
  }, [onlineBoards, singleTarget, selectedTargets]);

  // ── Options ─────────────────────────────────────────────────────────────
  const [ackMode, setAckMode] = useState(true);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [autoReconnect, setAutoReconnect] = useState(true);
  // CAN channel: 0 = CAN1, 1 = CAN2. Defaults to CAN2 so OTA can run while
  // telemetry is still on CAN1 (canalystii allows only one process per channel).
  const [canChannel, setCanChannel] = useState<0 | 1>(1);

  // ── Live OTA state — sourced from backend, no local simulation ──────────
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [chunksDone, setChunksDone] = useState(0);
  const [chunksTotal, setChunksTotal] = useState(0);
  const [boardRows, setBoardRows] = useState<Map<string, BoardOtaRow>>(new Map());
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  // Session timing for the elapsed / remaining / bus-load row.
  const sessionStartRef = useRef<number | null>(null);
  const [tick, setTick] = useState(0); // 1Hz heartbeat to refresh the display while busy
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const appendLog = useCallback((level: LogLevel, msg: string) => {
    setLog((l) => [...l, { ts: ts(), level, msg }].slice(-500));
  }, []);

  const clearLog = () => setLog([]);
  const saveLog = () => {
    const text = log.map((e) => `[${e.ts}] ${e.level.padEnd(5)} ${e.msg}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ota-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── File handling ──────────────────────────────────────────────────────
  const handleFile = useCallback(async (file: File) => {
    setFwError(""); setFwBytes(null); setFwCrc(null);
    setFwInitialSp(null); setFwResetHandler(null);
    setConvertedFrom("");
    setFwName(file.name);

    const ext = (file.name.toLowerCase().split(".").pop() ?? "");
    let buf: Uint8Array;

    if (ext === "bin") {
      buf = new Uint8Array(await file.arrayBuffer());
    } else if (ext === "elf") {
      try {
        const raw = new Uint8Array(await file.arrayBuffer());
        const r = parseElf(raw);
        buf = r.data;
        setConvertedFrom("ELF");
        appendLog(
          "INFO",
          `converted ELF (${raw.length} B) → flat bin (${buf.length} B), base 0x${r.baseAddr.toString(16).toUpperCase()}`,
        );
      } catch (exc: any) {
        const msg = String(exc?.message ?? exc);
        setFwError(`ELF parse failed: ${msg}`);
        appendLog("ERROR", `ELF parse failed: ${msg}`);
        return;
      }
    } else if (ext === "hex") {
      try {
        const text = await file.text();
        const r = parseHex(text);
        buf = r.data;
        setConvertedFrom("HEX");
        appendLog(
          "INFO",
          `converted Intel HEX (${text.length} chars) → flat bin (${buf.length} B), base 0x${r.baseAddr.toString(16).toUpperCase()}`,
        );
      } catch (exc: any) {
        const msg = String(exc?.message ?? exc);
        setFwError(`HEX parse failed: ${msg}`);
        appendLog("ERROR", `HEX parse failed: ${msg}`);
        return;
      }
    } else {
      setFwError("Supported: .bin, .elf, .hex");
      appendLog("ERROR", `unsupported file type: .${ext}`);
      return;
    }

    if (buf.length === 0) { setFwError("File is empty."); appendLog("ERROR", "empty image after conversion"); return; }
    if (buf.length > MAX_FW_SIZE) {
      setFwError(`Image too large: ${buf.length} > ${MAX_FW_SIZE} byte slot cap.`);
      appendLog("ERROR", `image too large: ${buf.length}`);
      return;
    }
    if (buf.length < 8) {
      setFwError("Image too small to contain a Cortex-M vector table (need ≥ 8 bytes).");
      appendLog("ERROR", "image < 8 bytes — no vector table");
      return;
    }

    // Cortex-M vector-table sanity check.
    // Use a DataView to read both u32s as LE — note `.buffer` may be wider than
    // the typed array view, so always anchor to byteOffset/byteLength.
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const initialSp = dv.getUint32(0x00, true) >>> 0;
    const resetVec  = dv.getUint32(0x04, true) >>> 0;
    const resetHandler = (resetVec & ~1) >>> 0; // strip the Thumb bit
    const crc = crc16Ccitt(buf);

    setFwBytes(buf);
    setFwCrc(crc);
    setFwInitialSp(initialSp);
    setFwResetHandler(resetHandler);

    if (initialSp < SRAM_MIN || initialSp > SRAM_MAX) {
      setFwError(
        `Initial SP 0x${initialSp.toString(16).padStart(8, "0").toUpperCase()} is not in the STM32 SRAM window ` +
        `(0x${SRAM_MIN.toString(16).toUpperCase()}–0x${SRAM_MAX.toString(16).toUpperCase()}).`,
      );
      appendLog("ERROR", `bad initial SP 0x${initialSp.toString(16).toUpperCase()}`);
      return;
    }
    if (resetHandler < FLASH_MIN || resetHandler > FLASH_MAX) {
      setFwError(
        `Reset handler 0x${resetHandler.toString(16).padStart(8, "0").toUpperCase()} is not in the H7 flash window ` +
        `(0x${FLASH_MIN.toString(16).toUpperCase()}–0x${FLASH_MAX.toString(16).toUpperCase()}).`,
      );
      appendLog("ERROR", `bad reset handler 0x${resetHandler.toString(16).toUpperCase()}`);
      return;
    }
    if ((resetVec & 1) === 0) {
      // Cortex-M instructions are Thumb — bit 0 of the reset vector should be 1.
      // Warn but don't reject; some toolchains emit clean addresses.
      appendLog("WARN", `reset vector 0x${resetVec.toString(16).toUpperCase()} has Thumb bit clear`);
    }

    appendLog(
      "INFO",
      `loaded ${file.name} — ${buf.length} B, ` +
      `SP 0x${initialSp.toString(16).padStart(8, "0").toUpperCase()}, ` +
      `reset 0x${resetHandler.toString(16).padStart(8, "0").toUpperCase()}, ` +
      `CRC16 0x${crc.toString(16).padStart(4, "0").toUpperCase()} (informational)`,
    );
  }, [appendLog]);

  const onPickFile = () => fileInputRef.current?.click();
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  }, [handleFile]);

  // ── Target collection ──────────────────────────────────────────────────
  const collectedTargets = useMemo<string[]>(() => {
    if (targetMode === "all") return [...onlineBoards];
    if (targetMode === "selected") return [...selectedTargets].filter((id) => onlineBoards.includes(id));
    return singleTarget && onlineBoards.includes(singleTarget) ? [singleTarget] : [];
  }, [targetMode, selectedTargets, singleTarget, onlineBoards]);

  // ── WebSocket subscription to live OTA events from the backend ─────────
  // Connects only while a session is active. The backend should publish:
  //   { type:"phase",        phase: <Phase> }
  //   { type:"progress",     chunks_done: <int>, chunks_total: <int> }
  //   { type:"board_status", node_id: <str>, status: { ...row } }
  //   { type:"log",          level: <LogLevel>, message: <str> }
  //   { type:"finished",     summary: { applied, failed, skipped, ... } }
  const openOtaSocket = useCallback((sessionId: string) => {
    try {
      const ws = new WebSocket(`${OTA_WS_URL}?session=${encodeURIComponent(sessionId)}`);
      wsRef.current = ws;
      ws.onopen = () => appendLog("INFO", "OTA stream attached");
      ws.onerror = () => appendLog("ERROR", "OTA stream error");
      ws.onclose = () => { appendLog("INFO", "OTA stream closed"); wsRef.current = null; };
      ws.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "phase") {
          setPhase(msg.phase as Phase);
          if (msg.phase === "PAUSED") setPaused(true);
          else if (msg.phase === "STREAMING") setPaused(false);
        } else if (msg.type === "progress") {
          setChunksDone(Number(msg.chunks_done) || 0);
          setChunksTotal(Number(msg.chunks_total) || 0);
        } else if (msg.type === "board_status") {
          const nodeId = String(msg.node_id);
          setBoardRows((prev) => {
            const next = new Map(prev);
            next.set(nodeId, {
              nodeId,
              readyStep1:    !!msg.status?.ready_step1,
              readyStep2:    !!msg.status?.ready_step2,
              chunksReceived: Number(msg.status?.chunks_received) || 0,
              retransmits:   Number(msg.status?.retransmit_count) || 0,
              crcMatch:      msg.status?.crc_match ?? null,
              applyStatus:   (msg.status?.apply_status || "PENDING") as ApplyStatus,
            });
            return next;
          });
        } else if (msg.type === "log") {
          appendLog((msg.level || "INFO") as LogLevel, String(msg.message ?? ""));
        } else if (msg.type === "finished") {
          setBusy(false);
          appendLog("INFO", `OTA finished — ${JSON.stringify(msg.summary || {})}`);
          ws.close();
        }
      };
    } catch (exc) {
      appendLog("ERROR", `OTA stream attach failed: ${exc}`);
    }
  }, [appendLog]);

  useEffect(() => () => { wsRef.current?.close(); wsRef.current = null; }, []);

  // ── Backend control calls ──────────────────────────────────────────────
  const startOta = async () => {
    if (!fwBytes || fwError) { toast.error("Load a valid firmware first."); return; }
    if (collectedTargets.length === 0) { toast.error("Pick at least one target board."); return; }
    if (!isConnected) { toast.error("CAN bridge is disconnected."); return; }

    setBusy(true);
    setPhase("INIT_STEP1");
    setChunksDone(0);
    setChunksTotal(Math.ceil(fwBytes.length / DATA_BYTES_PER_CHUNK));
    sessionStartRef.current = Date.now();
    // Backend remaps target string IDs (e.g. "USB:CAN2") to numeric NodeIDs
    // ("1", "2", …) and emits one board_status event per target right at the
    // start of /run_session. Don't pre-seed from the frontend's labels — that
    // creates phantom rows because the keys don't match.
    setBoardRows(new Map());

    // Multipart upload — backend takes the .bin + a JSON config blob.
    // Copy into a fresh ArrayBuffer so the Blob ctor sees ArrayBuffer (not the
    // wider ArrayBufferLike that TS 5.7 widens Uint8Array's buffer to).
    const fwBuffer = new ArrayBuffer(fwBytes.byteLength);
    new Uint8Array(fwBuffer).set(fwBytes);
    const form = new FormData();
    form.append("firmware", new Blob([fwBuffer], { type: "application/octet-stream" }), fwName);
    form.append("config", JSON.stringify({
      target_node_ids: collectedTargets,
      ack_mode: ackMode,
      fps,
      auto_reconnect: autoReconnect,
      channel: canChannel,
    }));

    try {
      const res = await fetch(`${BACKEND_BASE}/ota/start`, { method: "POST", body: form });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const data = await res.json();
      const sessionId = String(data.session_id ?? data.sessionId ?? "");
      appendLog("INFO", `OTA session started — id=${sessionId || "?"}, ${collectedTargets.length} targets`);
      if (sessionId) openOtaSocket(sessionId);
    } catch (exc: any) {
      setBusy(false);
      setPhase("ABORTED");
      const msg = String(exc?.message ?? exc);
      appendLog("ERROR", `OTA start failed: ${msg}`);
      toast.error(`OTA start failed: ${msg}`);
    }
  };

  const callBackend = async (path: string) => {
    try {
      const res = await fetch(`${BACKEND_BASE}${path}`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (exc: any) {
      appendLog("ERROR", `${path} failed: ${exc?.message ?? exc}`);
      toast.error(`${path} failed`);
    }
  };

  const onPause  = () => { if (busy && ackMode) { setPaused(true);  void callBackend("/ota/pause"); } };
  const onResume = () => { if (busy)            { setPaused(false); void callBackend("/ota/resume"); } };
  const onAbort  = () => {
    if (!busy) return;
    void callBackend("/ota/abort");
    appendLog("WARN", "abort requested");
  };

  // ── Derived view-state ─────────────────────────────────────────────────
  const fwReady = fwBytes !== null && !fwError;
  const fwSizeKb = fwBytes ? (fwBytes.length / 1024).toFixed(1) : "—";
  const fwCrcStr = fwCrc !== null ? "0x" + fwCrc.toString(16).padStart(4, "0").toUpperCase() : "—";
  const totalChunks = fwBytes ? Math.ceil(fwBytes.length / DATA_BYTES_PER_CHUNK) : 0;
  // Version extracted from filename: matches "_v1.2.3" or "v1.2.3" patterns.
  // Per SRS UI-F-34 the OTA protocol carries hw_type+fw_version in the first 16 bytes,
  // but real STM32 builds put the vector table at offset 0 — until the build pipeline
  // emits a true 16-byte header, falling back to the filename keeps the UI honest.
  const fwVersion = useMemo(() => {
    if (!fwName) return "";
    const m = fwName.match(/v?(\d+\.\d+(?:\.\d+)?)/i);
    return m ? `v${m[1]}` : "";
  }, [fwName]);
  const progressPct = chunksTotal > 0 ? Math.floor((chunksDone / chunksTotal) * 100) : 0;

  // ── Elapsed / remaining / bus-load (recomputed every `tick` while busy) ─
  const elapsedSec = useMemo(() => {
    if (!sessionStartRef.current) return 0;
    return Math.max(0, Math.floor((Date.now() - sessionStartRef.current) / 1000));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, busy, phase]);

  const remainingSec = useMemo(() => {
    if (!busy || chunksDone === 0 || chunksTotal === 0 || phase !== "STREAMING") return null;
    const rate = chunksDone / Math.max(1, elapsedSec); // chunks/sec actual
    if (rate <= 0) return null;
    const left = chunksTotal - chunksDone;
    return Math.max(0, Math.round(left / rate));
  }, [busy, chunksDone, chunksTotal, elapsedSec, phase]);

  // Bus load estimate: each frame ~125 bits @ 500 kbps → ~4400 fps theoretical max.
  // We cap at 100% so the UI doesn't show e.g. 110% if the user picks a high fps.
  const busLoadPct = useMemo(() => {
    if (!busy || phase !== "STREAMING") return 0;
    return Math.min(100, Math.round((fps / 4400) * 100));
  }, [busy, phase, fps]);

  const fmtSec = (s: number | null): string => {
    if (s === null) return "—";
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  const summary = useMemo(() => {
    const rows = [...boardRows.values()];
    return {
      applied: rows.filter((r) => r.applyStatus === "APPLIED").length,
      skipped: rows.filter((r) => r.applyStatus === "SKIPPED").length,
      failed:  rows.filter((r) => r.crcMatch === false).length,
      retrans: rows.reduce((acc, r) => acc + r.retransmits, 0),
    };
  }, [boardRows]);

  // ────────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header — connection state matches Logs.tsx / Dashboard.tsx convention */}
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">OTA Firmware Update</h1>
          <p className="text-muted-foreground text-sm">
            Pre-flight a firmware image and walk a fleet through the two-step INIT → stream → verify → apply sequence.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-[10px] font-mono ${PHASE_COLOR[phase]}`}>
            {PHASE_LABEL[phase]}
          </Badge>
          <Badge
            variant="outline"
            className={`text-[10px] font-mono ${
              isConnected
                ? "border-success/30 text-success bg-success/5"
                : "border-destructive/30 text-destructive bg-destructive/5"
            }`}
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1.5 ${isConnected ? "bg-success animate-pulse" : "bg-destructive"}`} />
            {isConnected ? <Wifi className="mr-1 h-3 w-3" /> : <WifiOff className="mr-1 h-3 w-3" />}
            {isConnected ? endpointLabel : "Disconnected"}
          </Badge>
        </div>
      </div>

      {/* Top row: firmware / target / options */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Firmware panel */}
        <Card className="glass-card">
          <CardHeader className="py-2 px-4 border-b border-border/20">
            <CardTitle className="text-sm flex items-center gap-2">
              <UploadCloud className="h-4 w-4 text-purple-400" /> Firmware Binary
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 space-y-3">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onClick={onPickFile}
              className="border-2 border-dashed border-border/40 rounded-md p-3 text-center cursor-pointer hover:border-purple-400/40 hover:bg-purple-400/5 transition-colors"
            >
              <FolderOpen className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
              <div className="text-[11px] text-muted-foreground">
                {fwName || "Drop .bin / .elf / .hex here, or click to browse"}
              </div>
              {convertedFrom && (
                <div className="mt-1 text-[9px] font-mono text-purple-300">
                  converted from {convertedFrom} → flat .bin
                </div>
              )}
              <input
                ref={fileInputRef} type="file" accept=".bin,.elf,.hex" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }}
              />
            </div>

            {/* Inline summary — matches the reference layout: File · Size · CRC16 · Ver */}
            {fwBytes && (
              <div className="text-[10px] font-mono leading-relaxed">
                <span className="text-muted-foreground">File: </span>
                <span className="text-foreground font-semibold">{fwName}</span>
                <span className="text-muted-foreground"> · Size: </span>
                <span>{fwSizeKb} KB</span>
                <span className="text-muted-foreground"> · CRC16: </span>
                <span>{fwCrcStr}</span>
                <span className="text-muted-foreground"> · Ver: </span>
                <span>{fwVersion || "—"}</span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-mono">
              <span className="text-muted-foreground">Size</span>
              <span>{fwBytes ? `${fwBytes.length} B (${fwSizeKb} KiB)` : "—"}</span>
              <span className="text-muted-foreground">CRC16</span>
              <span title="Informational — no equality check">{fwCrcStr}</span>
              <span className="text-muted-foreground">Initial SP</span>
              <span className={
                fwInitialSp === null ? ""
                : fwInitialSp >= SRAM_MIN && fwInitialSp <= SRAM_MAX ? "text-emerald-400"
                : "text-red-400"
              }>
                {fwInitialSp !== null
                  ? `0x${fwInitialSp.toString(16).padStart(8, "0").toUpperCase()} ${
                      fwInitialSp >= SRAM_MIN && fwInitialSp <= SRAM_MAX ? "✓" : "✗"
                    }`
                  : "—"}
              </span>
              <span className="text-muted-foreground">Reset handler</span>
              <span className={
                fwResetHandler === null ? ""
                : fwResetHandler >= FLASH_MIN && fwResetHandler <= FLASH_MAX ? "text-emerald-400"
                : "text-red-400"
              }>
                {fwResetHandler !== null
                  ? `0x${fwResetHandler.toString(16).padStart(8, "0").toUpperCase()} ${
                      fwResetHandler >= FLASH_MIN && fwResetHandler <= FLASH_MAX ? "✓" : "✗"
                    }`
                  : "—"}
              </span>
              <span className="text-muted-foreground">Chunks</span>
              <span>{totalChunks ? totalChunks.toLocaleString() : "—"}</span>
            </div>

            {fwError ? (
              <div className="flex items-start gap-2 rounded border border-red-400/30 bg-red-400/5 px-2 py-1.5">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-red-400 shrink-0" />
                <span className="text-[10px] text-red-300">{fwError}</span>
              </div>
            ) : fwReady ? (
              <div className="flex items-center gap-2 rounded border border-emerald-400/30 bg-emerald-400/5 px-2 py-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <span className="text-[10px] text-emerald-300">Validated — ready to flash.</span>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Target selection — populated from BoardContext */}
        <Card className="glass-card">
          <CardHeader className="py-2 px-4 border-b border-border/20">
            <CardTitle className="text-sm flex items-center gap-2">
              <Cpu className="h-4 w-4 text-blue-400" /> Target Selection
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 space-y-3">
            <RadioGroup value={targetMode} onValueChange={(v) => setTargetMode(v as TargetMode)} className="flex gap-3 flex-wrap">
              <div className="flex items-center gap-1.5"><RadioGroupItem value="all" id="all" /><Label htmlFor="all" className="text-[11px]">All ({onlineBoards.length})</Label></div>
              <div className="flex items-center gap-1.5"><RadioGroupItem value="selected" id="selected" /><Label htmlFor="selected" className="text-[11px]">Selected</Label></div>
              <div className="flex items-center gap-1.5"><RadioGroupItem value="single" id="single" /><Label htmlFor="single" className="text-[11px]">Single</Label></div>
            </RadioGroup>

            {targetMode === "selected" && (
              <div className="border border-border/30 rounded p-2 max-h-40 overflow-y-auto grid grid-cols-2 gap-1">
                {onlineBoards.length === 0 ? (
                  <div className="col-span-2 text-[10px] text-muted-foreground italic text-center py-2">No online boards.</div>
                ) : onlineBoards.map((id) => {
                  const checked = selectedTargets.has(id);
                  return (
                    <label key={id} className={`flex items-center gap-1 text-[10px] font-mono px-1 py-0.5 rounded cursor-pointer truncate ${checked ? "bg-blue-500/15 text-blue-300" : "hover:bg-accent/40"}`}>
                      <input
                        type="checkbox" checked={checked}
                        onChange={(e) => {
                          setSelectedTargets((s) => {
                            const next = new Set(s);
                            if (e.target.checked) next.add(id); else next.delete(id);
                            return next;
                          });
                        }}
                        className="accent-blue-500"
                      />
                      <span className="truncate">{id}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {targetMode === "single" && (
              <div>
                <Label className="text-[9px] uppercase font-bold text-muted-foreground mb-1 block">Board</Label>
                <Select value={singleTarget} onValueChange={setSingleTarget} disabled={onlineBoards.length === 0}>
                  <SelectTrigger className="h-7 text-[11px] font-mono">
                    <SelectValue placeholder={onlineBoards.length === 0 ? "No online boards" : "Pick a board"} />
                  </SelectTrigger>
                  <SelectContent>
                    {onlineBoards.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="text-[10px] font-mono text-muted-foreground border-t border-border/10 pt-2">
              Active targets: {collectedTargets.length}
              {onlineBoards.length === 0 && (
                <span className="text-amber-400 ml-2">· no boards online</span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Options */}
        <Card className="glass-card">
          <CardHeader className="py-2 px-4 border-b border-border/20">
            <CardTitle className="text-sm">Options</CardTitle>
          </CardHeader>
          <CardContent className="p-3 space-y-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div>CAN channel</div>
                <div className="text-[9px] text-muted-foreground">Use CAN2 to flash while telemetry stays on CAN1</div>
              </div>
              <Select
                value={String(canChannel)}
                onValueChange={(v) => setCanChannel(Number(v) as 0 | 1)}
                disabled={busy}
              >
                <SelectTrigger className="h-7 w-24 text-[11px] font-mono"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0" className="text-xs">CAN1</SelectItem>
                  <SelectItem value="1" className="text-xs">CAN2</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between border-t border-border/10 pt-2">
              <div>
                <div>ACK Mode</div>
                <div className="text-[9px] text-muted-foreground">Recommended — enables retransmits + pause</div>
              </div>
              <Switch checked={ackMode} onCheckedChange={setAckMode} disabled={busy} />
            </div>
            <div className="border-t border-border/10 pt-2">
              <div className="flex items-center justify-between mb-1">
                <Label className="text-[9px] uppercase font-bold text-muted-foreground">Data rate</Label>
                <span className="text-[10px] font-mono">{fps} fps</span>
              </div>
              <input
                type="range" min={1000} max={DEFAULT_FPS} step={100}
                value={fps} onChange={(e) => setFps(Number(e.target.value))}
                disabled={busy}
                className="w-full accent-purple-500"
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div>Auto-reconnect on CAN loss</div>
                <div className="text-[9px] text-muted-foreground">Resumes the session if the bus blips</div>
              </div>
              <Switch checked={autoReconnect} onCheckedChange={setAutoReconnect} disabled={busy} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Progress + buttons */}
      <Card className="glass-card">
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold">Phase:</span>
              <span className={`text-base font-bold ${PHASE_COLOR[phase]}`}>{PHASE_LABEL[phase]}</span>
            </div>
            <span className="text-[10px] font-mono text-muted-foreground">
              {chunksDone.toLocaleString()} / {chunksTotal.toLocaleString()} chunks · {progressPct}%
            </span>
          </div>
          <Progress value={progressPct} className="h-2" />
          <div className="text-[10px] font-mono text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
            <span>Elapsed <span className="text-foreground">{busy ? fmtSec(elapsedSec) : "—"}</span></span>
            <span>·</span>
            <span>Remaining <span className="text-foreground">~{fmtSec(remainingSec)}</span></span>
            <span>·</span>
            <span>Bus load <span className="text-foreground">{busLoadPct}%</span></span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm" className="h-7 text-xs bg-purple-600 hover:bg-purple-500"
              onClick={startOta}
              disabled={busy || !fwReady || collectedTargets.length === 0 || !isConnected}
            >
              <Play className="mr-1 h-3 w-3" /> Start OTA
            </Button>
            <Button
              size="sm" variant="outline" className="h-7 text-xs"
              onClick={paused ? onResume : onPause}
              disabled={!busy || !ackMode}
            >
              <Pause className="mr-1 h-3 w-3" /> {paused ? "Resume" : "Pause"}
            </Button>
            <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={onAbort} disabled={!busy}>
              <Square className="mr-1 h-3 w-3" /> Abort
            </Button>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={saveLog} disabled={log.length === 0}>
                <Save className="mr-1 h-3 w-3" /> Save Log
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={clearLog} disabled={log.length === 0}>
                <Trash2 className="mr-1 h-3 w-3" /> Clear Log
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-3 text-[10px] font-mono pt-1 border-t border-border/10">
            <span className="text-emerald-400">Applied: {summary.applied}</span>
            <span className="text-muted-foreground">Skipped: {summary.skipped}</span>
            <span className="text-red-400">Failed: {summary.failed}</span>
            <span className="text-amber-400">Retransmits: {summary.retrans}</span>
          </div>
        </CardContent>
      </Card>

      {/* Board status + log */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <Card className="glass-card xl:col-span-2 min-h-[260px] flex flex-col">
          <CardHeader className="py-2 px-4 border-b border-border/20 flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Board Status</CardTitle>
            <Badge variant="outline" className="text-[10px]">{boardRows.size} rows</Badge>
          </CardHeader>
          <CardContent className="p-0 flex-1 overflow-hidden">
            <div className="overflow-auto max-h-[420px]">
              <table className="w-full text-[11px] font-mono">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left p-2 font-bold">NodeID</th>
                    <th className="text-left p-2 font-bold">READY</th>
                    <th className="text-left p-2 font-bold">Chunks</th>
                    <th className="text-left p-2 font-bold">Retransmit</th>
                    <th className="text-left p-2 font-bold">CRC</th>
                    <th className="text-left p-2 font-bold">Apply</th>
                  </tr>
                </thead>
                <tbody>
                  {boardRows.size === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-muted-foreground italic">
                        {isConnected
                          ? "Pick targets and start an OTA to populate this table."
                          : "Connect via Connect to bring the bridge up."}
                      </td>
                    </tr>
                  ) : (
                    [...boardRows.values()]
                      .sort((a, b) => {
                        // Numeric sort when both NodeIDs are integers (e.g. "1","2","10").
                        const an = Number(a.nodeId), bn = Number(b.nodeId);
                        if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
                        return a.nodeId.localeCompare(b.nodeId);
                      })
                      .map((r) => {
                        // READY column: per SRS UI-F-36 the active board set is the step-2
                        // respondent set. Show YES once the bootloader has acknowledged INIT.
                        const ready = r.readyStep2;
                        const partial = r.readyStep1 && !r.readyStep2;
                        return (
                          <tr key={r.nodeId} className="border-t border-border/10">
                            <td className="p-1.5 font-bold">#{r.nodeId}</td>
                            <td className="p-1.5">
                              {ready ? (
                                <span className="text-emerald-400 font-bold">YES</span>
                              ) : partial ? (
                                <span className="text-amber-400">app·</span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="p-1.5">
                              <span className={r.chunksReceived > 0 ? "text-foreground" : "text-muted-foreground"}>
                                {r.chunksReceived.toLocaleString()}/{chunksTotal.toLocaleString()}
                              </span>
                            </td>
                            <td className="p-1.5">
                              <span className={r.retransmits > 0 ? "text-amber-400" : "text-muted-foreground"}>
                                {r.retransmits}
                              </span>
                            </td>
                            <td className="p-1.5">
                              {r.crcMatch === null ? <span className="text-muted-foreground">—</span>
                                : r.crcMatch ? <span className="text-emerald-400 font-bold">OK</span>
                                : <span className="text-red-400 font-bold">FAIL</span>}
                            </td>
                            <td className="p-1.5">
                              <span className={
                                r.applyStatus === "APPLIED" ? "text-emerald-400"
                                : r.applyStatus === "SKIPPED" ? "text-muted-foreground"
                                : r.applyStatus === "ABORTED" ? "text-red-400"
                                : "text-foreground"
                              }>
                                {/* Reference layout uses Title Case ("Pending", "Applied"). */}
                                {r.applyStatus.charAt(0) + r.applyStatus.slice(1).toLowerCase()}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card min-h-[260px] flex flex-col">
          <CardHeader className="py-2 px-4 border-b border-border/20 flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Log</CardTitle>
            <Badge variant="outline" className="text-[10px]">{log.length}</Badge>
          </CardHeader>
          <CardContent className="flex-1 p-0 overflow-hidden relative">
            <div className="absolute inset-0 overflow-y-auto font-mono text-[10px] p-2 space-y-0.5 scrollbar-thin">
              {log.length === 0 ? (
                <div className="h-full flex items-center justify-center text-muted-foreground/50 italic text-xs">No log entries yet.</div>
              ) : (
                log.slice(-200).map((e, i) => (
                  <div key={i} className="flex gap-2 border-b border-border/5 pb-0.5">
                    <span className="text-muted-foreground/40 text-[9px] shrink-0">[{e.ts}]</span>
                    <span className={`text-[9px] font-bold w-10 shrink-0 ${LOG_COLOR[e.level]}`}>{e.level}</span>
                    <span className={`break-all leading-snug ${LOG_COLOR[e.level]}`}>{e.msg}</span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {!isConnected && (
        <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-destructive shrink-0" />
          <span className="text-[10px] text-destructive">
            CAN bridge is Disconnected. Open{" "}
            <Link to="/connect" className="underline text-destructive hover:text-foreground">
              <Plug className="inline h-3 w-3" /> Connect
            </Link>{" "}
            to bring the link up — this page reads its fleet directly from the dashboard's live board state.
          </span>
        </div>
      )}
    </div>
  );
}
