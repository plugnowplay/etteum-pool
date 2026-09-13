import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ThemeProvider } from "./hooks/useTheme";
import { WebSocketProvider } from "./hooks/useWebSocket";
import { WsQuerySync } from "./hooks/useWsQuerySync";
import { ToastProvider } from "./components/ui/toast";
import { queryClient } from "./lib/queryClient";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WebSocketProvider>
          {/* Turns websocket events into targeted cache invalidations so pages
              never need their own polling timers. */}
          <WsQuerySync />
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </WebSocketProvider>
      </ToastProvider>
    </QueryClientProvider>
  </ThemeProvider>
);
