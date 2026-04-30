import { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from "react";
import { useTcpStream } from "@/hooks/useTcpStream";

// ── Types ────────────────────────────────────────────────────────────────

export interface BoardData {
  id: string;
  outputs: boolean[];
  inputs: boolean[];
  status: "online" | "offline";
  ip: string;
  port: number;
  last_heartbeat: number;
}

export interface BoardLogEntry {
  id: number;
  boardId: string;
  type: "output" | "input" | "timer" | "rule";
  index: number;
  value: boolean;
  label: string;
  timestamp: string;
}

// Timer with multiple outputs, each with ON/OFF delay
export interface TimerOutputConfig {
  outputIndex: number;
  onDelaySec: number;   // seconds before turning ON
  offDelaySec: number;  // seconds before turning OFF
  onAuto: boolean;      // true = auto ON when Run clicked
  offAuto: boolean;     // true = auto OFF after ON completes
}

export interface TimerPreset {
  id: number;
  name: string;
  outputs: TimerOutputConfig[];
  enabled: boolean;
}

// A running countdown for a single output toggle
export interface RunningTimer {
  presetId: number;
  name: string;
  outputIndex: number;
  value: boolean;        // what to apply when done
  remainingSec: number;
  // Cycle support: if set, after this timer fires schedule next phase
  cycle?: true;
  nextValue?: boolean;   // the value for the next phase
  nextDelaySec?: number; // the delay for the next phase
  autoPhase?: "on" | "off";  // for auto mode: current phase
}

export interface InputRule {
  id: number;
  name: string;
  inputIndex: number;
  trigger: "high" | "low";
  actions: { outputIndex: number; value: boolean }[];
  enabled: boolean;
  linkedTimerId?: number;  // if set, use timer delays instead of immediate
}

export interface BoardConfig {
  boardName: string;
  outputNames: string[];
  inputNames: string[];
  timerPresets: TimerPreset[];
  inputRules: InputRule[];
}

interface BoardContextType {
  boards: BoardData[];
  selectedBoardId: string | null;
  selectBoard: (id: string) => void;
  toggleOutput: (boardId: string, outputIndex: number, value: boolean) => void;
  writeOutputs: (boardId: string, outputs: boolean[]) => void;
  refreshBoards: () => void;
  connected: boolean;
  isDemo: boolean;
  logs: BoardLogEntry[];
  clearLogs: () => void;
  getConfig: (boardId: string) => BoardConfig;
  updateConfig: (boardId: string, config: Partial<BoardConfig>) => void;
  addTimerPreset: (boardId: string, preset: Omit<TimerPreset, "id">) => void;
  removeTimerPreset: (boardId: string, presetId: number) => void;
  runAutoTimer: (boardId: string, presetId: number) => void;
  stopAutoTimer: (boardId: string, presetId: number) => void;
  runningTimers: Record<string, RunningTimer[]>;
  addInputRule: (boardId: string, rule: Omit<InputRule, "id">) => void;
  removeInputRule: (boardId: string, ruleId: number) => void;
  toggleInputRule: (boardId: string, ruleId: number) => void;
}

const BoardContext = createContext<BoardContextType | null>(null);

// ── Helpers ─────────────────────────────────────────────────────────────

function loadJSON<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function saveJSON(key: string, value: unknown) { localStorage.setItem(key, JSON.stringify(value)); }

const DEFAULT_CONFIG: BoardConfig = {
  boardName: "", outputNames: Array(15).fill(""), inputNames: Array(4).fill(""),
  timerPresets: [], inputRules: [],
};

const HW_OUT = ["DO1 (PA8)","DO2 (PA9)","DO3 (PA10)","DO4 (PA11)","DO6 (PC6)","DO7 (PC7)","DO8 (PC8)","DO9 (PC9)","DO10 (PB12)","DO11 (PB13)","DO12 (PB14)","DO13 (PB15)","DO14 (PA15)","DO15 (PD0)","DO16"];
const HW_IN = ["DI1 (PA4)","DI2 (PA5)","DI3 (PA6)","DI4 (PA7)"];

let logCounter = 0;
let presetIdCounter = 100;
let ruleIdCounter = 100;
const CAN_OUTPUT_ID = "100";
const CAN_INPUT_ID = "200";

function encodeOutputs(outputs: boolean[]): [number, number] {
  let b0 = 0, b1 = 0;
  for (let i = 0; i < Math.min(8, outputs.length); i++) { if (outputs[i]) b0 |= 1 << i; }
  for (let i = 8; i < Math.min(15, outputs.length); i++) { if (outputs[i]) b1 |= 1 << (i - 8); }
  return [b0, b1];
}
function decodeInputs(b: number): boolean[] { return [!!(b & 1), !!(b & 2), !!(b & 4), !!(b & 8)]; }
function sendFrame(outputs: boolean[], send: (msg: string) => void) {
  const [b0, b1] = encodeOutputs(outputs);
  send(`${CAN_OUTPUT_ID}#${b0.toString(16).padStart(2,'0').toUpperCase()}${b1.toString(16).padStart(2,'0').toUpperCase()}\n`);
}

// ── Provider ─────────────────────────────────────────────────────────────

export function BoardProvider({ children }: { children: ReactNode }) {
  const { feed, status, activeEndpoint, sendMessage } = useTcpStream();

  const [boards, setBoards] = useState<BoardData[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const isDemo = false;
  const [logs, setLogs] = useState<BoardLogEntry[]>(() => loadJSON("boards.logs", []));
  const [configs, setConfigs] = useState<Record<string, BoardConfig>>(() => loadJSON("boards.configs", {}));
  const [runningTimers, setRunningTimers] = useState<Record<string, RunningTimer[]>>({});
  // Track which rule IDs are currently active (input is still in triggered state)
  const activeRulesRef = useRef<Set<number>>(new Set());


  const prevBoardsRef = useRef<BoardData[]>(boards);
  const boardsRef = useRef(boards); boardsRef.current = boards;
  const sendRef = useRef(sendMessage); sendRef.current = sendMessage;
  const configsRef = useRef(configs); configsRef.current = configs;
  const connected = !!activeEndpoint && (status.includes("Streaming") || status.includes("BRIDGE_CONNECTED") || status.includes("ACTIVE"));

  useEffect(() => { saveJSON("boards.logs", logs.slice(-500)); }, [logs]);
  useEffect(() => { saveJSON("boards.configs", configs); }, [configs]);

  // Reset all I/O to LOW when connection drops
  useEffect(() => {
    if (!connected) {
      setBoards(prev => prev.map(b => ({
        ...b,
        status: "offline" as const,
        inputs: Array(4).fill(false),
        outputs: Array(15).fill(false),
      })));
    }
  }, [connected]);

  // ── Sync configs to backend DB ──
  const syncConfigToBackend = useCallback(async (boardId: string, cfg: BoardConfig) => {
    try {
      await fetch("http://localhost:8000/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          board_id: boardId,
          board_name: cfg.boardName,
          output_names: cfg.outputNames,
          input_names: cfg.inputNames,
        }),
      });
    } catch { /* backend may not be running */ }
  }, []);

  const syncTimerToBackend = useCallback(async (boardId: string, preset: Omit<TimerPreset, "id"> & { id?: number }) => {
    try {
      const res = await fetch("http://localhost:8000/timers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board_id: boardId, name: preset.name, outputs: preset.outputs, enabled: preset.enabled }),
      });
      const data = await res.json();
      return data.timer?.id;
    } catch { return undefined; }
  }, []);

  const syncRuleToBackend = useCallback(async (boardId: string, rule: Omit<InputRule, "id"> & { id?: number }) => {
    try {
      await fetch("http://localhost:8000/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          board_id: boardId, name: rule.name, input_index: rule.inputIndex,
          trigger: rule.trigger, actions: rule.actions, enabled: rule.enabled,
          linked_timer_id: rule.linkedTimerId || null,
        }),
      });
    } catch { /* backend may not be running */ }
  }, []);

  const deleteTimerFromBackend = useCallback(async (timerId: number) => {
    try { await fetch(`http://localhost:8000/timers/${timerId}`, { method: "DELETE" }); } catch {}
  }, []);

  const deleteRuleFromBackend = useCallback(async (ruleId: number) => {
    try { await fetch(`http://localhost:8000/rules/${ruleId}`, { method: "DELETE" }); } catch {}
  }, []);

  const toggleRuleOnBackend = useCallback(async (ruleId: number) => {
    try { await fetch(`http://localhost:8000/rules/${ruleId}/toggle`, { method: "PATCH" }); } catch {}
  }, []);

  // Load configs from backend on mount
  useEffect(() => {
    const loadFromBackend = async () => {
      try {
        const res = await fetch("http://localhost:8000/config");
        const data = await res.json();
        if (data && typeof data === "object" && Object.keys(data).length > 0) {
          setConfigs(prev => {
            const merged = { ...prev };
            for (const [boardId, cfg] of Object.entries(data) as [string, any][]) {
              merged[boardId] = {
                boardName: cfg.board_name ?? cfg.boardName ?? "",
                outputNames: cfg.output_names ?? cfg.outputNames ?? Array(15).fill(""),
                inputNames: cfg.input_names ?? cfg.inputNames ?? Array(4).fill(""),
                timerPresets: (cfg.timerPresets || []).map((t: any) => ({
                  id: t.id, name: t.name, enabled: t.enabled ?? true,
                  outputs: (t.outputs || []).map((o: any) => ({
                    ...o, onAuto: o.onAuto ?? false, offAuto: o.offAuto ?? false,
                  })),
                })),
                inputRules: (cfg.inputRules || []).map((r: any) => ({
                  id: r.id, name: r.name, inputIndex: r.inputIndex ?? r.input_index ?? 0,
                  trigger: r.trigger ?? r.trigger_type ?? "high",
                  actions: r.actions ?? [], enabled: r.enabled ?? true,
                  linkedTimerId: r.linkedTimerId ?? r.linked_timer_id ?? undefined,
                })),
              };
            }
            return merged;
          });
        }
      } catch { /* backend not running, use localStorage */ }
    };
    loadFromBackend();
  }, []);

  // Log helper
  const addLog = useCallback((boardId: string, type: BoardLogEntry["type"], index: number, value: boolean, customLabel?: string) => {
    const cfg = configsRef.current[boardId] || DEFAULT_CONFIG;
    const names = (type === "output" || type === "timer") ? cfg.outputNames : cfg.inputNames;
    const hw = (type === "output" || type === "timer") ? HW_OUT[index] : HW_IN[index];
    const label = customLabel || names[index] || hw || `${(type === "input" || type === "rule") ? "DI" : "DO"}${index+1}`;
    setLogs(prev => [...prev, { id: logCounter++, boardId, type, index, value, label, timestamp: new Date().toISOString() }].slice(-500));
  }, []);

  // Fetch boards from backend API
  useEffect(() => {
    const fetchBoards = async () => {
      try {
        const res = await fetch("http://localhost:8000/boards");
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          setBoards(prev => {
            let changed = false;
            const merged = [...prev];
            for (const b of data) {
              const idx = merged.findIndex(m => m.id === b.id);
              if (idx >= 0) {
                // Only update if status or inputs actually changed
                const existing = merged[idx];
                const newInputs = b.inputs || existing.inputs;
                const inputsSame = existing.inputs.every((v: boolean, i: number) => v === newInputs[i]);
                if (existing.status !== b.status || !inputsSame) {
                  const wentOffline = existing.status === "online" && b.status === "offline";
                  const newOutputs = wentOffline ? Array(15).fill(false) : existing.outputs;
                  merged[idx] = { ...existing, status: b.status, ip: b.ip, port: b.port, last_heartbeat: b.last_heartbeat, inputs: newInputs, outputs: newOutputs };
                  changed = true;
                  if (wentOffline) {
                    setRunningTimers(prev => {
                      const next = { ...prev };
                      delete next[existing.id];
                      return next;
                    });
                    addLog(existing.id, "output", 0, false, "Connection Lost - All Outputs Reset to OFF");
                    // Assuming hardware resets itself, we only update UI state to match.
                  }
                }
              } else {
                merged.push({ ...b, outputs: b.outputs || Array(15).fill(false), inputs: b.inputs || Array(4).fill(false) });
                changed = true;
              }
            }
            return changed ? merged : prev;
          });
          setSelectedBoardId(prev => prev || data[0].id);
        }
      } catch { /* backend not running */ }
    };
    fetchBoards();
    const interval = setInterval(fetchBoards, 5000);
    return () => clearInterval(interval);
  }, []);

  // Auto-register from TCP or USB-CAN
  useEffect(() => {
    if (!connected || !activeEndpoint) return;
    const isSerial = activeEndpoint.protocol === "usb-can";
    const boardId = isSerial
      ? `USB:${activeEndpoint.comPort}`
      : `${activeEndpoint.ip}:${activeEndpoint.port}`;
    setBoards(prev => {
      const exists = prev.find(b => b.id === boardId);
      if (exists) return prev.map(b => b.id === boardId ? { ...b, status: "online" as const, last_heartbeat: Date.now()/1000 } : b);
      return [...prev, {
        id: boardId, outputs: Array(15).fill(false), inputs: Array(4).fill(false),
        status: "online" as const,
        ip: isSerial ? (activeEndpoint.comPort || "") : activeEndpoint.ip,
        port: isSerial ? (activeEndpoint.baudRate || 115200) : Number(activeEndpoint.port),
        last_heartbeat: Date.now()/1000,
      }];
    });
    setConfigs(prev => prev[boardId] ? prev : { ...prev, [boardId]: { boardName: "", outputNames: [...HW_OUT], inputNames: [...HW_IN], timerPresets: [], inputRules: [] } });
    setSelectedBoardId(prev => prev || boardId);
  }, [connected, activeEndpoint]);

  // Parse RX: 200#XX → inputs
  useEffect(() => {
    if (feed.length === 0 || !activeEndpoint) return;
    const latest = feed[feed.length - 1];
    if (latest.type !== 'rx') return;
    const isSerial = activeEndpoint.protocol === "usb-can";
    const boardId = isSerial
      ? `USB:${activeEndpoint.comPort}`
      : `${activeEndpoint.ip}:${activeEndpoint.port}`;
    let text = latest.message;
    if (latest.raw) {
      const bytes: number[] = [];
      for (let i = 0; i < latest.raw.length; i += 2) bytes.push(parseInt(latest.raw.slice(i, i + 2), 16));
      text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
    }
    for (const line of text.split(/[\r\n]+/).filter(l => l.trim())) {
      const h = line.indexOf('#');
      if (h === -1) continue;
      if (line.slice(0, h).trim() === CAN_INPUT_ID) {
        const v = parseInt(line.slice(h + 1).trim().slice(0, 2), 16);
        if (!isNaN(v)) {
          const newInputs = decodeInputs(v);
          setBoards(prev => prev.map(b => {
            if (b.id !== boardId) return b;
            // Only create new state if inputs actually changed
            const same = b.inputs.every((val, i) => val === newInputs[i]);
            if (same) return b; // same reference = no re-render
            return { ...b, inputs: newInputs, last_heartbeat: Date.now()/1000, status: "online" };
          }));
        }
      }
    }
  }, [feed, activeEndpoint]);

  // Track changes + evaluate input rules (only on actual value changes)
  useEffect(() => {
    const prev = prevBoardsRef.current;
    for (const board of boards) {
      const old = prev.find(b => b.id === board.id);
      if (!old) continue;

      // Compare by value, not reference
      const inputsChanged = board.inputs.some((v, i) => v !== old.inputs[i]);
      const outputsChanged = board.outputs.some((v, i) => v !== old.outputs[i]);

      if (!inputsChanged && !outputsChanged) continue;

      if (inputsChanged) board.inputs.forEach((v, i) => { if (v !== old.inputs[i]) addLog(board.id, "input", i, v); });
      if (outputsChanged) board.outputs.forEach((v, i) => { if (v !== old.outputs[i]) addLog(board.id, "output", i, v); });

      if (!inputsChanged) continue; // rules only fire on input changes

      const cfg = configsRef.current[board.id];
      if (cfg?.inputRules) {
        for (const rule of cfg.inputRules) {
          if (!rule.enabled) continue;
          const oldVal = old.inputs[rule.inputIndex];
          const newVal = board.inputs[rule.inputIndex];
          if (oldVal === newVal) continue; // this specific input didn't change

          const inputNow = newVal;
          const triggered = (rule.trigger === "high" && inputNow) || (rule.trigger === "low" && !inputNow);

          // Edge detection: only fire ON rising/falling edge, not while level stays same
          if (triggered && activeRulesRef.current.has(rule.id)) continue; // already running
          if (!triggered) activeRulesRef.current.delete(rule.id); // input went back — allow re-arm

          // If triggered → apply actions as configured
          // If reverse (input went opposite) → apply REVERSE of actions automatically
          const updated = [...board.outputs];
          let changed = false;

          // Check if this rule is linked to a timer (created via "Both")
          const linkedTimer = rule.linkedTimerId ? cfg.timerPresets.find(t => t.id === rule.linkedTimerId) : null;

          if (triggered) {
            activeRulesRef.current.add(rule.id); // mark as active — block re-trigger
            if (linkedTimer) {
              // ── INPUT HIGH → schedule ON with onDelay ──
              // No cycling. Timer is just a lead-in delay for the start phase.
              for (const a of rule.actions) {
                const timerCfg = linkedTimer.outputs.find(o => o.outputIndex === a.outputIndex);
                const onDelay = timerCfg?.onDelaySec ?? 0;
                const startVal = a.value;

                // Cancel any pending timers for this output first
                setRunningTimers(prev => ({
                  ...prev,
                  [board.id]: (prev[board.id]||[]).filter(t =>
                    !(t.outputIndex === a.outputIndex && t.presetId === linkedTimer.id)
                  ),
                }));

                if (onDelay > 0) {
                  // Schedule ON after delay
                  addLog(board.id, "rule", a.outputIndex, startVal,
                    `${rule.name}: DO${a.outputIndex+1}→${startVal?"ON":"OFF"} in ${onDelay}s`);
                  setRunningTimers(prev => ({
                    ...prev,
                    [board.id]: [...(prev[board.id]||[]).filter(t =>
                      !(t.outputIndex === a.outputIndex && t.presetId === linkedTimer.id)
                    ), { presetId: linkedTimer.id, name: rule.name, outputIndex: a.outputIndex,
                         value: startVal, remainingSec: onDelay }],
                  }));
                } else {
                  // onDelay = 0 → apply start phase immediately
                  updated[a.outputIndex] = startVal;
                  changed = true;
                  addLog(board.id, "rule", a.outputIndex, startVal,
                    `${rule.name}: DO${a.outputIndex+1}→${startVal?"ON":"OFF"}`);
                }
              }
              // Send only outputs that have 0 delay
              const zeroDelayOutputs = rule.actions.filter(a => {
                const tc = linkedTimer.outputs.find(o => o.outputIndex === a.outputIndex);
                return (tc?.onDelaySec ?? 0) === 0;
              });
              if (zeroDelayOutputs.length > 0) {
                setBoards(p => p.map(b => b.id === board.id ? { ...b, outputs: updated } : b));
                sendFrame(updated, sendRef.current);
              } else {
                setBoards(p => p.map(b => b.id === board.id ? { ...b, outputs: updated } : b));
              }
            } else {
              // Not linked — immediate
              for (const a of rule.actions) {
                if (updated[a.outputIndex] !== a.value) { updated[a.outputIndex] = a.value; changed = true; addLog(board.id, "rule", a.outputIndex, a.value, `${rule.name}: DO${a.outputIndex+1}→${a.value?"ON":"OFF"}`); }
              }
            }
          } else {
            // Input went back — cancel all cycling timers for this rule's outputs, turn OFF
            if (linkedTimer) {
              // ── INPUT LOW → schedule OFF with offDelay ──
              for (const a of rule.actions) {
                const timerCfg = linkedTimer.outputs.find(o => o.outputIndex === a.outputIndex);
                const offDelay = timerCfg?.offDelaySec ?? 0;
                const nextVal = !a.value;

                // Cancel any pending ON timer for this output
                setRunningTimers(prev => ({
                  ...prev,
                  [board.id]: (prev[board.id]||[]).filter(t =>
                    !(t.outputIndex === a.outputIndex && t.presetId === linkedTimer.id)
                  ),
                }));

                if (offDelay > 0) {
                  // Schedule OFF after delay
                  addLog(board.id, "rule", a.outputIndex, nextVal,
                    `${rule.name}: DO${a.outputIndex+1}→${nextVal?"ON":"OFF"} in ${offDelay}s`);
                  setRunningTimers(prev => ({
                    ...prev,
                    [board.id]: [...(prev[board.id]||[]).filter(t =>
                      !(t.outputIndex === a.outputIndex && t.presetId === linkedTimer.id)
                    ), { presetId: linkedTimer.id, name: rule.name, outputIndex: a.outputIndex,
                         value: nextVal, remainingSec: offDelay }],
                  }));
                } else {
                  // offDelay = 0 → apply reverse phase immediately
                  updated[a.outputIndex] = nextVal;
                  changed = true;
                  addLog(board.id, "rule", a.outputIndex, nextVal,
                    `${rule.name}: DO${a.outputIndex+1}→${nextVal?"ON":"OFF"} (reverse)`);
                }
              }
              const zeroDelayOutputs = rule.actions.filter(a => {
                const tc = linkedTimer.outputs.find(o => o.outputIndex === a.outputIndex);
                return (tc?.offDelaySec ?? 0) === 0;
              });
              if (zeroDelayOutputs.length > 0) {
                setBoards(p => p.map(b => b.id === board.id ? { ...b, outputs: updated } : b));
                sendFrame(updated, sendRef.current);
              } else {
                setBoards(p => p.map(b => b.id === board.id ? { ...b, outputs: updated } : b));
              }
            } else {
              for (const a of rule.actions) {
                const reverseVal = !a.value;
                if (updated[a.outputIndex] !== reverseVal) { updated[a.outputIndex] = reverseVal; changed = true; addLog(board.id, "rule", a.outputIndex, reverseVal, `${rule.name}: DO${a.outputIndex+1}→${reverseVal?"ON":"OFF"} (reverse)`); }
              }
            }
          }

          if (changed && !linkedTimer) {
            setBoards(p => p.map(b => b.id === board.id ? { ...b, outputs: updated } : b));
            sendFrame(updated, sendRef.current);
            const affectedIndices = rule.actions.map(a => a.outputIndex);
            setRunningTimers(prev => ({
              ...prev,
              [board.id]: (prev[board.id] || []).filter(t => !affectedIndices.includes(t.outputIndex)),
            }));
          }
        }
      }
    }
    prevBoardsRef.current = boards;
  }, [boards, addLog]);

  // ── Timer countdown — every second, with auto-mode cycling ──
  useEffect(() => {
    const id = setInterval(() => {
      setRunningTimers(prev => {
        const next = { ...prev };
        let anyChanged = false;
        for (const boardId of Object.keys(next)) {
          const nextList: RunningTimer[] = [];
          for (const t of next[boardId]) {
            const rem = t.remainingSec - 1;
            if (rem <= 0) {
              // Timer done — apply value to hardware
              const board = boardsRef.current.find(b => b.id === boardId);
              if (board) {
                const updated = [...board.outputs];
                updated[t.outputIndex] = t.value;
                setBoards(p => p.map(b => b.id === boardId ? { ...b, outputs: updated } : b));
                sendFrame(updated, sendRef.current);
                addLog(boardId, "timer", t.outputIndex, t.value,
                  `${t.name} — DO${t.outputIndex+1} → ${t.value?"ON":"OFF"}`);
              }

              // Auto single-shot: after ON fires → schedule OFF if offAuto is true
              if (t.autoPhase === "on") {
                // ON just fired → check if OFF should auto-fire
                const cfg = configsRef.current[boardId];
                const preset = cfg?.timerPresets.find(p => p.id === t.presetId);
                const timerCfg = preset?.outputs.find(o => o.outputIndex === t.outputIndex);
                if (timerCfg?.offAuto && timerCfg.offDelaySec > 0) {
                  nextList.push({
                    presetId: t.presetId, name: t.name, outputIndex: t.outputIndex,
                    value: false, remainingSec: timerCfg.offDelaySec, autoPhase: "off",
                  });
                }
                // No further cycling — single shot only
              }
              // autoPhase === "off" → done, no more scheduling
              anyChanged = true;
            } else {
              nextList.push({ ...t, remainingSec: rem });
              anyChanged = true;
            }
          }
          next[boardId] = nextList;
        }
        return anyChanged ? next : prev;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [addLog]);

  // ── Toggle output: checks timer config for ON/OFF delays ──
  const toggleOutput = useCallback((boardId: string, outputIndex: number, value: boolean) => {
    // Always update UI immediately
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId) return b;
      const o = [...b.outputs]; o[outputIndex] = value;
      return { ...b, outputs: o };
    }));

    // Check if this output has a timer preset
    const cfg = configsRef.current[boardId];
    // Find timer that includes this outputIndex
    const timer = cfg?.timerPresets.find(t => t.enabled && t.outputs.some(o => o.outputIndex === outputIndex));
    const timerCfg = timer?.outputs.find(o => o.outputIndex === outputIndex);

    if (timer && timerCfg) {
      const delay = value ? timerCfg.onDelaySec : timerCfg.offDelaySec;
      if (delay > 0) {
        addLog(boardId, "timer", outputIndex, value, `DO${outputIndex+1} → ${value?"ON":"OFF"} (${delay}s delay)`);
        setRunningTimers(prev => ({
          ...prev,
          [boardId]: [
            ...(prev[boardId]||[]).filter(t => t.outputIndex !== outputIndex),
            { presetId: timer.id, name: timer.name, outputIndex, value, remainingSec: delay },
          ],
        }));
        return;
      }
    }

    // No timer or delay=0 — send instantly
    const board = boardsRef.current.find(b => b.id === boardId);
    if (board) {
      const n = [...board.outputs]; n[outputIndex] = value;
      sendFrame(n, sendRef.current);
    }
  }, [addLog]);

  // All ON / All OFF — respects per-output timers
  const writeOutputs = useCallback((boardId: string, outputs: boolean[]) => {
    setBoards(prev => prev.map(b => b.id === boardId ? { ...b, outputs } : b));

    const cfg = configsRef.current[boardId];
    const instantOutputs = [...outputs];
    const timersToStart: RunningTimer[] = [];

    outputs.forEach((val, i) => {
      // Find timer config for this output
      const timer = cfg?.timerPresets.find(t => t.enabled && t.outputs.some(o => o.outputIndex === i));
      const timerCfg = timer?.outputs.find(o => o.outputIndex === i);
      if (timer && timerCfg) {
        const delay = val ? timerCfg.onDelaySec : timerCfg.offDelaySec;
        if (delay > 0) {
          const board = boardsRef.current.find(b => b.id === boardId);
          instantOutputs[i] = board?.outputs[i] ?? false;
          timersToStart.push({ presetId: timer.id, name: timer.name, outputIndex: i, value: val, remainingSec: delay });
        }
      }
    });

    sendFrame(instantOutputs, sendRef.current);

    if (timersToStart.length > 0) {
      setRunningTimers(prev => ({
        ...prev,
        [boardId]: [
          ...(prev[boardId]||[]).filter(t => !timersToStart.some(ts => ts.outputIndex === t.outputIndex)),
          ...timersToStart,
        ],
      }));
    }
  }, []);

  // Timer CRUD
  const addTimerPreset = useCallback((boardId: string, preset: Omit<TimerPreset, "id">) => {
    const localId = presetIdCounter++;
    setConfigs(prev => {
      const cfg = prev[boardId] || { ...DEFAULT_CONFIG };
      return { ...prev, [boardId]: { ...cfg, timerPresets: [...(cfg.timerPresets||[]), { ...preset, id: localId }] } };
    });
    // Sync to backend — backend returns real DB id
    syncTimerToBackend(boardId, { ...preset, id: localId });
  }, [syncTimerToBackend]);

  const removeTimerPreset = useCallback((boardId: string, presetId: number) => {
    setConfigs(prev => {
      const cfg = prev[boardId]; if (!cfg) return prev;
      return { ...prev, [boardId]: { ...cfg, timerPresets: cfg.timerPresets.filter(t => t.id !== presetId) } };
    });
    setRunningTimers(prev => ({ ...prev, [boardId]: (prev[boardId]||[]).filter(t => t.presetId !== presetId) }));
    deleteTimerFromBackend(presetId);
  }, [deleteTimerFromBackend]);

  // Run auto timer — for each output with onAuto: schedule ON after onDelaySec
  // When ON fires, if offAuto: schedule OFF after offDelaySec. Single shot, no cycling.
  const runAutoTimer = useCallback((boardId: string, presetId: number) => {
    const cfg = configsRef.current[boardId];
    const preset = cfg?.timerPresets.find(t => t.id === presetId);
    if (!preset) return;

    const board = boardsRef.current.find(b => b.id === boardId);
    if (!board) return;

    const updated = [...board.outputs];
    const newTimers: RunningTimer[] = [];

    for (const o of preset.outputs) {
      if (o.onAuto) {
        if (o.onDelaySec > 0) {
          // Schedule ON after delay
          addLog(boardId, "timer", o.outputIndex, true, `${preset.name}: DO${o.outputIndex+1} → ON in ${o.onDelaySec}s`);
          newTimers.push({
            presetId, name: preset.name, outputIndex: o.outputIndex,
            value: true, remainingSec: o.onDelaySec, autoPhase: "on",
          });
        } else {
          // ON instantly
          updated[o.outputIndex] = true;
          addLog(boardId, "timer", o.outputIndex, true, `${preset.name}: DO${o.outputIndex+1} → ON`);
          // If offAuto, schedule OFF
          if (o.offAuto && o.offDelaySec > 0) {
            newTimers.push({
              presetId, name: preset.name, outputIndex: o.outputIndex,
              value: false, remainingSec: o.offDelaySec, autoPhase: "off",
            });
          }
        }
      }
    }

    // Apply immediate changes
    setBoards(p => p.map(b => b.id === boardId ? { ...b, outputs: updated } : b));
    if (updated.some((v, i) => v !== board.outputs[i])) {
      sendFrame(updated, sendRef.current);
    }

    // Add running timers
    if (newTimers.length > 0) {
      setRunningTimers(prev => ({
        ...prev,
        [boardId]: [
          ...(prev[boardId] || []).filter(t => t.presetId !== presetId),
          ...newTimers,
        ],
      }));
    }
  }, [addLog]);

  // Stop auto timer — cancel all running timers for this preset and turn off outputs
  const stopAutoTimer = useCallback((boardId: string, presetId: number) => {
    const cfg = configsRef.current[boardId];
    const preset = cfg?.timerPresets.find(t => t.id === presetId);

    // Cancel running timers
    setRunningTimers(prev => ({
      ...prev,
      [boardId]: (prev[boardId] || []).filter(t => t.presetId !== presetId),
    }));

    // Turn off all outputs in this preset
    if (preset) {
      const board = boardsRef.current.find(b => b.id === boardId);
      if (board) {
        const updated = [...board.outputs];
        for (const o of preset.outputs) {
          updated[o.outputIndex] = false;
          addLog(boardId, "timer", o.outputIndex, false, `${preset.name}: DO${o.outputIndex+1} → OFF (stopped)`);
        }
        setBoards(p => p.map(b => b.id === boardId ? { ...b, outputs: updated } : b));
        sendFrame(updated, sendRef.current);
      }
    }
  }, [addLog]);

  // Input rule CRUD
  const addInputRule = useCallback((boardId: string, rule: Omit<InputRule, "id">) => {
    const localId = ruleIdCounter++;
    setConfigs(prev => {
      const cfg = prev[boardId] || { ...DEFAULT_CONFIG };
      return { ...prev, [boardId]: { ...cfg, inputRules: [...(cfg.inputRules||[]), { ...rule, id: localId }] } };
    });
    syncRuleToBackend(boardId, { ...rule, id: localId });
  }, [syncRuleToBackend]);

  const removeInputRule = useCallback((boardId: string, ruleId: number) => {
    setConfigs(prev => {
      const cfg = prev[boardId]; if (!cfg) return prev;
      return { ...prev, [boardId]: { ...cfg, inputRules: cfg.inputRules.filter(r => r.id !== ruleId) } };
    });
    deleteRuleFromBackend(ruleId);
  }, [deleteRuleFromBackend]);

  const toggleInputRule = useCallback((boardId: string, ruleId: number) => {
    setConfigs(prev => {
      const cfg = prev[boardId]; if (!cfg) return prev;
      return { ...prev, [boardId]: { ...cfg, inputRules: cfg.inputRules.map(r => r.id === ruleId ? { ...r, enabled: !r.enabled } : r) } };
    });
    toggleRuleOnBackend(ruleId);
  }, [toggleRuleOnBackend]);

  const refreshBoards = useCallback(() => {
    const now = Date.now()/1000;
    setBoards(prev => prev.map(b => b.status === "online" && now - b.last_heartbeat > 10 ? { ...b, status: "offline" as const, inputs: Array(4).fill(false), outputs: Array(15).fill(false) } : b));
  }, []);

  const selectBoard = useCallback((id: string) => { setSelectedBoardId(id); }, []);
  const clearLogs = useCallback(() => { setLogs([]); }, []);
  const getConfig = useCallback((boardId: string): BoardConfig => configsRef.current[boardId] || { ...DEFAULT_CONFIG }, []);
  const updateConfig = useCallback((boardId: string, partial: Partial<BoardConfig>) => {
    setConfigs(prev => {
      const updated = { ...(prev[boardId] || { ...DEFAULT_CONFIG }), ...partial };
      // Debounced sync to backend (config updates happen on every keystroke)
      syncConfigToBackend(boardId, updated);
      return { ...prev, [boardId]: updated };
    });
  }, [syncConfigToBackend]);

  return (
    <BoardContext.Provider value={{
      boards, selectedBoardId, selectBoard, toggleOutput, writeOutputs, refreshBoards,
      connected, isDemo, logs, clearLogs, getConfig, updateConfig,
      addTimerPreset, removeTimerPreset, runAutoTimer, stopAutoTimer, runningTimers,
      addInputRule, removeInputRule, toggleInputRule,
    }}>
      {children}
    </BoardContext.Provider>
  );
}

export function useBoards() {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error("useBoards must be used within BoardProvider");
  return ctx;
}
