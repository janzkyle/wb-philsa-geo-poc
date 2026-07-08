import MapView from "./components/MapView";
import LayerPanel from "./components/LayerPanel";
import ChatPanel from "./components/ChatPanel";
import "./App.css";

// Layout only — all state lives in the layer store (state/mapStore.ts),
// which the LayerPanel (human) and ChatPanel (AI tools) both drive.
export default function App() {
  return (
    <div className="app">
      <LayerPanel />
      <div className="mapwrap">
        <MapView />
      </div>
      <ChatPanel />
    </div>
  );
}
