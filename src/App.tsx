import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DashboardLayout } from "@/components/DashboardLayout";
import Dashboard from "./pages/Dashboard";
import Connect from "./pages/Connect";
import SendData from "./pages/SendData";
import ServerMonitor from "./pages/ServerMonitor";
import Logs from "./pages/Logs";
import CrefMessages from "./pages/CrefMessages";
import SettingsPage from "./pages/SettingsPage";
import NotFound from "./pages/NotFound";
import { TcpProvider } from "./contexts/TcpContext";
import { BoardProvider } from "./contexts/BoardContext";
import BoardControl from "./pages/BoardControl";
import BoardConfig from "./pages/BoardConfig";
import OtaUpdate from "./pages/OtaUpdate";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TcpProvider>
      <BoardProvider>
        <TooltipProvider>
          <Sonner />
          <BrowserRouter>
            <DashboardLayout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/connect" element={<Connect />} />
                <Route path="/board-control" element={<BoardControl />} />
                <Route path="/board-config" element={<BoardConfig />} />
                <Route path="/send-data" element={<SendData />} />
                <Route path="/server-monitor" element={<ServerMonitor />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="/board-logs" element={<CrefMessages />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/ota" element={<OtaUpdate />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </DashboardLayout>
          </BrowserRouter>
        </TooltipProvider>
      </BoardProvider>
    </TcpProvider>
  </QueryClientProvider>
);

export default App;
