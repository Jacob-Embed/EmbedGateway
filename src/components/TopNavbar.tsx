import { SidebarTrigger } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bell, Wifi } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

export function TopNavbar() {
  return (
    <header className="h-14 border-b border-border flex items-center justify-between px-4 bg-card/50 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <SidebarTrigger />
        <div className="flex items-center gap-2">
          <Wifi className="h-4 w-4 text-success" />
          <Badge variant="outline" className="text-xs border-success/30 text-success">
            System Online
          </Badge>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <ThemeToggle />
        <button className="relative p-2 rounded-md hover:bg-accent transition-colors">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary animate-pulse-glow" />
        </button>
        <Avatar className="h-8 w-8">
          <AvatarFallback className="bg-primary/10 text-primary text-xs">CG</AvatarFallback>
        </Avatar>
      </div>
    </header>
  );
}
