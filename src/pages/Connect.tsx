import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Plug, Unplug, Loader2, Usb, RefreshCw, AlertTriangle, ArrowUpCircle, ArrowDownCircle, Power, PowerOff } from "lucide-react";
import { toast } from "sonner";
import { useTcpStream } from "@/hooks/useTcpStream";

interface DetectedDevice {
  type: string;
  port: string;
  description: string;
  manufacturer: string;
  interface: string;
  driver_ok: boolean;
  channel?: number;
  likely_can?: boolean;
  windows_status?: string;
  error?: string;
}

export default function Connect() {
  const { status, connect, isTauri, disconnect, activeEndpoint, rxCount, txCount, fps } = useTcpStream();

  const [protocol, setProtocol] = useState(activeEndpoint?.protocol ?? "tcp");
  const [ip, setIp] = useState(activeEndpoint?.ip ?? "127.0.0.1");
  const [port, setPort] = useState(activeEndpoint?.port ?? "8001");
  const [comPort, setComPort] = useState(activeEndpoint?.comPort ?? "");
  const [baudRate, setBaudRate] = useState(activeEndpoint?.baudRate ?? 500000);
  const [canChannel, setCanChannel] = useState(0);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);

  // USB-CAN devices
  const [devices, setDevices] = useState<DetectedDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<DetectedDevice | null>(null);

  useEffect(() => {
    if (activeEndpoint) {
      setIp(activeEndpoint.ip);
      setPort(activeEndpoint.port);
      setProtocol(activeEndpoint.protocol);
      if (activeEndpoint.comPort) setComPort(activeEndpoint.comPort);
      if (activeEndpoint.baudRate) setBaudRate(activeEndpoint.baudRate);
    }
  }, [activeEndpoint]);

  useEffect(() => {
    const isLive = status === "BRIDGE_CONNECTED" || status === "UDP_BRIDGE_ACTIVE"
      || status === "SERIAL_CONNECTED" || status.includes("Streaming");
    setConnected(isLive);
  }, [status]);

  const scanDevices = async () => {
    setScanning(true);
    try {
      const res = await fetch("http://localhost:8000/serial/detect");
      const data = await res.json();
      if (data.devices) {
        setDevices(data.devices);
        const okDevice = data.devices.find((d: DetectedDevice) => d.driver_ok);
        if (okDevice && !selectedDevice) {
          setSelectedDevice(okDevice);
          setCanChannel(okDevice.channel ?? 0);
        }
      }
      if (!data.has_python_can) {
        toast.error("python-can not installed on backend");
      }
    } catch {
      toast.error("Backend not reachable");
    }
    setScanning(false);
  };

  useEffect(() => {
    if (protocol === "usb-can") scanDevices();
  }, [protocol]);

  const handleConnect = async () => {
    setLoading(true);
    if (protocol === "usb-can") {
      if (selectedDevice?.interface === "canalystii") {
        connect("", "", protocol, `CAN${canChannel + 1}`, baudRate);
      } else if (selectedDevice?.interface === "serial") {
        connect("", "", protocol, selectedDevice.port, baudRate);
      }
    } else {
      connect(ip, port, protocol);
    }
    setTimeout(() => setLoading(false), 800);
  };

  const handleDisconnect = () => {
    disconnect();
    toast.info("Connection terminated");
  };

  const isUsbCan = protocol === "usb-can";
  const hasDriverIssue = devices.some(d => !d.driver_ok);

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">CAN Configuration</h1>
        <p className="text-muted-foreground text-sm">Channel, bus speed & connection</p>
      </div>

      {/* Configuration */}
      <Card className="glass-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Connection Settings</CardTitle>
          <CardDescription className="text-xs">Select protocol, channel & bus speed</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Protocol */}
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase font-bold text-muted-foreground">Protocol</Label>
            <Select value={protocol} onValueChange={setProtocol} disabled={connected}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="tcp">TCP (Live)</SelectItem>
                <SelectItem value="udp">UDP (Ethernet)</SelectItem>
                <SelectItem value="usb-can">USB-CAN (Waveshare USB-CAN-B)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* TCP/UDP */}
          {!isUsbCan && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold text-muted-foreground">IP Address</Label>
                <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="127.0.0.1" disabled={connected} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold text-muted-foreground">Port</Label>
                <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="8001" disabled={connected} className="h-9" />
              </div>
            </div>
          )}

          {/* USB-CAN */}
          {isUsbCan && (
            <div className="space-y-3">
              {/* Devices */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] uppercase font-bold text-muted-foreground">Device</Label>
                  <Button variant="ghost" size="sm" className="h-6 text-[9px] gap-1" onClick={scanDevices} disabled={scanning || connected}>
                    <RefreshCw className={`h-3 w-3 ${scanning ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                </div>

                {devices.length > 0 ? (
                  <div className="space-y-1.5">
                    {devices.map((d, i) => (
                      <button key={i} onClick={() => { setSelectedDevice(d); setCanChannel(d.channel ?? 0); }} disabled={connected}
                        className={`w-full text-left p-2.5 rounded-lg border transition-all ${
                          selectedDevice === d ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "border-border/30 hover:bg-accent/30"
                        } ${!d.driver_ok ? "opacity-50" : ""}`}>
                        <div className="flex items-center gap-2">
                          <Usb className={`h-3.5 w-3.5 ${d.driver_ok ? "text-blue-400" : "text-destructive"}`} />
                          <span className="text-xs font-bold flex-1 truncate">{d.description}</span>
                          <Badge variant="outline" className={`text-[7px] ${d.driver_ok ? "border-green-400/30 text-green-400" : "border-destructive/30 text-destructive"}`}>
                            {d.driver_ok ? "Ready" : "No Driver"}
                          </Badge>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="p-3 rounded-lg border border-border/30 bg-muted/20 text-center">
                    <p className="text-[10px] text-muted-foreground">No devices found. Connect USB-CAN-B and click Refresh.</p>
                  </div>
                )}
              </div>

              {hasDriverIssue && (
                <div className="p-2.5 rounded-lg border border-yellow-500/30 bg-yellow-500/5">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-yellow-400 shrink-0 mt-0.5" />
                    <div className="text-[10px] text-muted-foreground">
                      <span className="font-bold text-yellow-400">Driver needed.</span> Run <span className="font-mono">zadig-2.9.exe</span> on Desktop &gt; Options &gt; List All Devices &gt; Select device &gt; WinUSB &gt; Install Driver.
                    </div>
                  </div>
                </div>
              )}

              {/* Channel + Bitrate */}
              {selectedDevice && selectedDevice.driver_ok && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-[10px] uppercase font-bold text-muted-foreground">Channel</Label>
                    <Select value={String(canChannel)} onValueChange={v => setCanChannel(Number(v))} disabled={connected}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">CAN1 (H, S, L)</SelectItem>
                        <SelectItem value="1">CAN2 (H, G, L)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10px] uppercase font-bold text-muted-foreground">Bus Speed</Label>
                    <Select value={String(baudRate)} onValueChange={v => setBaudRate(Number(v))} disabled={connected}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="125000">125 kbps</SelectItem>
                        <SelectItem value="250000">250 kbps</SelectItem>
                        <SelectItem value="500000">500 kbps</SelectItem>
                        <SelectItem value="1000000">1 Mbps</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>
          )}

          {!isTauri && !isUsbCan && (
            <p className="text-[9px] text-warning italic">Python backend acts as bridge for Sockets in browser mode.</p>
          )}
        </CardContent>
      </Card>

      {/* Bus Status Bar — bottom */}
      <Card className={`glass-card ${connected ? "border-green-500/30" : "border-border/30"}`}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className={`h-3 w-3 rounded-full ${connected ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
                <span className={`text-sm font-bold ${connected ? "text-green-400" : "text-red-400"}`}>
                  {connected ? "ON BUS" : "OFF BUS"}
                </span>
              </div>
              {connected && activeEndpoint && (
                <span className="text-xs font-mono text-muted-foreground">
                  {isUsbCan ? `USB-CAN CAN${canChannel+1} @ ${(baudRate/1000).toFixed(0)}k` : `${activeEndpoint.ip}:${activeEndpoint.port} (${protocol.toUpperCase()})`}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <ArrowUpCircle className="h-3.5 w-3.5 text-orange-400" />
                <span className="text-xs font-mono font-bold text-orange-400">{txCount}</span>
                <span className="text-[9px] text-muted-foreground">TX</span>
              </div>
              <div className="flex items-center gap-1.5">
                <ArrowDownCircle className="h-3.5 w-3.5 text-blue-400" />
                <span className="text-xs font-mono font-bold text-blue-400">{rxCount}</span>
                <span className="text-[9px] text-muted-foreground">RX</span>
              </div>
              {connected && (
                <div className="flex items-center gap-1">
                  <span className="text-xs font-mono font-bold text-green-400">{fps}</span>
                  <span className="text-[9px] text-muted-foreground">fps</span>
                </div>
              )}
              {!connected ? (
                <Button size="sm" className="h-7 text-xs gap-1.5 bg-green-600 hover:bg-green-500" onClick={handleConnect}
                  disabled={loading || (isUsbCan ? (!selectedDevice || !selectedDevice.driver_ok) : (!ip || !port))}>
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                  Go ON Bus
                </Button>
              ) : (
                <Button size="sm" variant="destructive" className="h-7 text-xs gap-1.5" onClick={handleDisconnect}>
                  <PowerOff className="h-3.5 w-3.5" />
                  Go OFF Bus
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
