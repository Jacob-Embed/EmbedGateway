import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

export interface Interaction {
  type: 'tx' | 'rx';
  message: string;
  timestamp: string;
  raw?: string; // lowercase hex string of raw bytes (no separators), when available
}

export interface ActiveEndpoint {
  ip: string;
  port: string;
  protocol: string;
  comPort?: string;
  baudRate?: number;
}

interface TcpContextType {
  feed: Interaction[];
  status: string;
  activeEndpoint: ActiveEndpoint | null;
  isTauri: boolean;
  rxCount: number;
  txCount: number;
  rxFps: number;
  txFps: number;
  connect: (ip: string, port: string, protocol: string, comPort?: string, baudRate?: number) => void;
  sendMessage: (msg: string | Uint8Array, displayAs?: string) => Promise<void>;
  disconnect: () => void;
  clearFeed: () => void;
}

const TcpContext = createContext<TcpContextType | undefined>(undefined);

const ENDPOINT_STORAGE_KEY = "tcp.activeEndpoint";

const readStoredEndpoint = (): ActiveEndpoint | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ENDPOINT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.protocol) return parsed as ActiveEndpoint;
  } catch {}
  return null;
};

export const TcpProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [feed, setFeed] = useState<Interaction[]>([]);
  const [status, setStatus] = useState("Disconnected");
  const [activeEndpoint, setActiveEndpoint] = useState<ActiveEndpoint | null>(() => readStoredEndpoint());
  const wsRef = useRef<WebSocket | null>(null);
  const hasAutoReconnected = useRef(false);
  const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

  // Lifetime counters (not limited by feed buffer)
  const [rxCount, setRxCount] = useState(0);
  const [txCount, setTxCount] = useState(0);
  // FPS tracking
  const [rxFps, setRxFps] = useState(0);
  const [txFps, setTxFps] = useState(0);
  const rxFpsCounterRef = useRef(0);
  const txFpsCounterRef = useRef(0);

  useEffect(() => {
    const id = setInterval(() => {
      setRxFps(rxFpsCounterRef.current);
      setTxFps(txFpsCounterRef.current);
      rxFpsCounterRef.current = 0;
      txFpsCounterRef.current = 0;
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const clearFeed = () => { setFeed([]); setRxCount(0); setTxCount(0); };

  const disconnect = () => {
    if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
    }
    setStatus("Disconnected");
    setActiveEndpoint(null);
    try { window.localStorage.removeItem(ENDPOINT_STORAGE_KEY); } catch {}
  };

  const connect = (ip: string, port: string, protocol: string, comPort?: string, baudRate?: number) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    const endpoint: ActiveEndpoint = { ip, port, protocol, comPort, baudRate };
    setActiveEndpoint(endpoint);
    try {
      window.localStorage.setItem(ENDPOINT_STORAGE_KEY, JSON.stringify(endpoint));
    } catch {}

    const isSerial = protocol === "usb-can";

    if (isTauri && !isSerial) {
      setStatus(`Connecting (${protocol.toUpperCase()} Native)...`);
      import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke<string>("connect_to_server", { ip, port, protocol })
          .then(() => setStatus(`Streaming Active (Native)`))
          .catch((err) => setStatus(`Error: ${err}`));
      });
    } else {
      // For USB-CAN, use the serial WebSocket bridge; for TCP/UDP use the tcp bridge
      const wsUrl = isSerial
        ? "ws://localhost:8000/ws/serial"
        : "ws://localhost:8000/ws/tcp";

      setStatus(isSerial
        ? `Bridge: Opening ${comPort}...`
        : `Bridge: Linking ${protocol.toUpperCase()}...`);

      const ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        let data: any;
        try {
          data = JSON.parse(event.data);
        } catch (err) {
          console.error("[RX] failed to parse frame:", err, event.data);
          return;
        }

        // Handle errors from serial bridge
        if (data.error) {
          setStatus(`Error: ${data.error}`);
          return;
        }

        if (data.status && !(data.format === "hex")) {
          setStatus(data.status);
          return;
        }
        if (data.message) {
          const isHex = data.format === "hex";
          const raw = isHex ? data.message : undefined;
          const display = isHex
            ? (data.message.match(/.{1,2}/g)?.join(' ').toUpperCase() ?? '')
            : data.message;
          const rx: Interaction = {
            type: 'rx',
            message: display,
            raw,
            timestamp: data.timestamp || new Date().toISOString()
          };
          setFeed(prev => [...prev.slice(-99), rx]);
          setRxCount(c => c + 1);
          rxFpsCounterRef.current++;
          const label = isSerial ? `Streaming (USB-CAN ${comPort})` : `Streaming (${protocol.toUpperCase()})`;
          setStatus(label);
        }
      };

      ws.onopen = () => {
        if (isSerial) {
          // comPort like "CAN1" or "CAN2" → canalystii interface; "COM3" → serial
          const isCanalystii = comPort?.startsWith("CAN");
          if (isCanalystii) {
            const channel = comPort === "CAN2" ? 1 : 0;
            const cfg = { interface: "canalystii", channel, bitrate: baudRate || 500000 };
            console.log("[USB-CAN WS] open — sending config", cfg);
            ws.send(JSON.stringify(cfg));
          } else {
            const cfg = { interface: "serial", com_port: comPort, baud_rate: baudRate || 115200 };
            console.log("[Serial WS] open — sending config", cfg);
            ws.send(JSON.stringify(cfg));
          }
        } else {
          console.log("[TCP WS] open — sending config", { ip, port, protocol });
          ws.send(JSON.stringify({ ip, port, protocol }));
        }
      };
      ws.onerror = (e) => console.error("[WS] error", e);
      ws.onclose = (e) => {
        console.log("[WS] closed", e.code, e.reason);
        setStatus("Bridge Disconnected");
      };
      wsRef.current = ws;
    }
  };

  const sendMessage = async (msg: string | Uint8Array, displayAs?: string) => {
    const isBinary = msg instanceof Uint8Array;
    const display = displayAs ?? (isBinary
        ? Array.from(msg as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join(' ')
        : (msg as string));

    const tx: Interaction = {
        type: 'tx',
        message: display,
        timestamp: new Date().toISOString()
    };
    setFeed(prev => [...prev.slice(-99), tx]);
    setTxCount(c => c + 1);
    txFpsCounterRef.current++;

    if (isTauri) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        if (isBinary) {
          await invoke("send_bytes_to_server", { data: Array.from(msg as Uint8Array) });
        } else {
          await invoke("send_to_server", { message: msg as string });
        }
      } catch (e) {
        console.error("Failed to send natively:", e);
      }
    } else if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      if (isBinary) {
        wsRef.current.send(msg as Uint8Array);
      } else {
        wsRef.current.send(msg as string);
      }
    }
  };

  useEffect(() => {
    if (isTauri) {
      const unlistenData = listen<any>("tcp-data", (event) => {
        const isHex = event.payload.format === "hex";
        const raw = isHex ? event.payload.message : undefined;
        const display = isHex
          ? (event.payload.message.match(/.{1,2}/g)?.join(' ').toUpperCase() ?? '')
          : event.payload.message;
        const rx: Interaction = {
            type: 'rx',
            message: display,
            raw,
            timestamp: event.payload.timestamp
        };
        setFeed(prev => [...prev.slice(-99), rx]);
        setRxCount(c => c + 1);
        rxFpsCounterRef.current++;
        setStatus("Streaming Active (Native)");
      });
      
      const unlistenStatus = listen<string>("tcp-status", (event) => {
        setStatus(event.payload);
      });

      return () => {
        unlistenData.then(f => f());
        unlistenStatus.then(f => f());
      };
    }
  }, [isTauri]);

  // Auto-reconnect on mount if an endpoint is persisted (survives page refresh).
  useEffect(() => {
    if (hasAutoReconnected.current) return;
    const saved = readStoredEndpoint();
    if (saved) {
      hasAutoReconnected.current = true;
      connect(saved.ip, saved.port, saved.protocol, saved.comPort, saved.baudRate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <TcpContext.Provider value={{
        feed,
        status,
        activeEndpoint,
        isTauri,
        rxCount,
        txCount,
        rxFps,
        txFps,
        connect,
        sendMessage,
        disconnect,
        clearFeed
    }}>
      {children}
    </TcpContext.Provider>
  );
};

export const useTcp = () => {
  const context = useContext(TcpContext);
  if (context === undefined) {
    throw new Error("useTcp must be used within a TcpProvider");
  }
  return context;
};
