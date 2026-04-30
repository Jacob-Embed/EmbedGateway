import {
  LayoutDashboard,
  Plug,
  Send,
  Server,
  ScrollText,
  Settings,
  Radio,
  ToggleLeft,
  SlidersHorizontal,
  Activity,
  Usb,
} from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useLocation } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { useTcpStream } from "@/hooks/useTcpStream";

const mainItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Connect", url: "/connect", icon: Plug },
];

const controlItems = [
  { title: "Board Control", url: "/board-control", icon: ToggleLeft },
  { title: "Board Configuration", url: "/board-config", icon: SlidersHorizontal },
  { title: "Send Data", url: "/send-data", icon: Send },
];

const monitorItems = [
  { title: "Server Monitor", url: "/server-monitor", icon: Server },
  { title: "Logs", url: "/logs", icon: ScrollText },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const { status, activeEndpoint } = useTcpStream();

  const isConnected = status.includes("Streaming") || status.includes("CONNECTED") || status.includes("ACTIVE");
  const isUsbCan = activeEndpoint?.protocol === "usb-can";

  const renderGroup = (label: string, items: typeof mainItems) => (
    <SidebarGroup>
      <SidebarGroupLabel className="text-[9px] uppercase tracking-widest opacity-50">{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton asChild>
                <NavLink
                  to={item.url}
                  end={item.url === "/"}
                  className="hover:bg-accent/50 transition-colors"
                  activeClassName="bg-primary/10 text-primary font-medium"
                >
                  <item.icon className="mr-2 h-4 w-4 shrink-0" />
                  {!collapsed && <span>{item.title}</span>}
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <Radio className="h-6 w-6 text-primary shrink-0" />
          {!collapsed && (
            <span className="font-bold text-lg tracking-tight">CANGateway</span>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        {renderGroup("Main", mainItems)}
        {renderGroup("Control", controlItems)}
        {renderGroup("Monitor", monitorItems)}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <NavLink to="/settings" className="hover:bg-accent/50 transition-colors" activeClassName="bg-primary/10 text-primary font-medium">
                    <Settings className="mr-2 h-4 w-4 shrink-0" />
                    {!collapsed && <span>Settings</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {!collapsed && (
        <SidebarFooter className="p-3 border-t border-border/20">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full shrink-0 ${isConnected ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
            <div className="text-[10px] truncate">
              {isConnected ? (
                <span className="text-green-400 font-mono">
                  {isUsbCan ? <Usb className="inline h-3 w-3 mr-1" /> : <Activity className="inline h-3 w-3 mr-1" />}
                  {isUsbCan ? activeEndpoint?.comPort : `${activeEndpoint?.ip}:${activeEndpoint?.port}`}
                </span>
              ) : (
                <span className="text-muted-foreground">Disconnected</span>
              )}
            </div>
          </div>
        </SidebarFooter>
      )}
    </Sidebar>
  );
}
