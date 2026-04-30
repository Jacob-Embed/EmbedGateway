import { useTcp } from "@/contexts/TcpContext";

export type { Interaction, ActiveEndpoint } from "@/contexts/TcpContext";

export function useTcpStream() {
  const context = useTcp();

  return {
    feed: context.feed,
    status: context.status,
    activeEndpoint: context.activeEndpoint,
    connect: context.connect,
    isTauri: context.isTauri,
    rxCount: context.rxCount,
    txCount: context.txCount,
    rxFps: context.rxFps,
    txFps: context.txFps,
    sendMessage: context.sendMessage,
    disconnect: context.disconnect,
    clearFeed: context.clearFeed
  };
}
